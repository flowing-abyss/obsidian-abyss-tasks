import type { SecretStorage } from 'obsidian';
import type { ChatGptDesktop } from './chatGptLoopback';
import {
  allowedPlan,
  hostRecord,
  InvalidGrant,
  nextGrant,
  oauth,
  planApi,
  registrationCallback,
  signInRequest,
  tokenRequest,
  verifiedIdentity,
  type PlanAccount,
  type PlanHost,
} from './chatGptOAuth';
import { createChatGptPlanModel, planHttpFailure, planModelChoices } from './chatGptPlanModel';
import { ProviderFailure } from './providerFailure';
import { chatGptPlanSecret } from './providerSettings';

export interface ChatGptPlanState {
  desktop: boolean;
  active: string | null;
  connected: boolean;
  ready: boolean;
  accounts: ReadonlyArray<{ client: string; label: string }>;
}

type SecretPort = Pick<SecretStorage, 'getSecret' | 'setSecret'>;
/** Only this vault-local OAuth registration can authorize the plan transport. */
export class ChatGptPlan {
  readonly #lifetime = new AbortController();
  #accountScope = new AbortController();
  #signingIn = false;
  constructor(
    private readonly storage: SecretPort,
    private readonly fetch: typeof window.fetch,
    private readonly desktop: ChatGptDesktop | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): PlanHost | undefined {
    try {
      const saved = this.storage.getSecret(chatGptPlanSecret);
      return saved === null || saved === ''
        ? undefined
        : hostRecord.parse(JSON.parse(saved) as unknown);
    } catch {
      throw new ProviderFailure('plan-storage');
    }
  }
  private write(record: PlanHost): void {
    try {
      this.storage.setSecret(chatGptPlanSecret, JSON.stringify(record));
    } catch {
      throw new ProviderFailure('plan-storage');
    }
  }
  private requireDesktop(): ChatGptDesktop {
    if (this.desktop === undefined) throw new ProviderFailure('plan-desktop');
    this.#lifetime.signal.throwIfAborted();
    return this.desktop;
  }
  private replaceAccountScope(): void {
    this.#accountScope.abort();
    this.#accountScope = new AbortController();
  }
  state(): ChatGptPlanState {
    const record = this.desktop === undefined ? undefined : this.read();
    const selected = record?.accounts.find((account) => account.client === record.active);
    return {
      desktop: this.desktop !== undefined,
      active: selected?.client ?? null,
      connected: selected?.grant !== undefined,
      ready: allowedPlan(selected),
      accounts: (record?.accounts ?? []).map(({ client, email }) => ({
        client,
        label: `${email === '' ? 'ChatGPT account' : email} · ${client.slice(-6)}`,
      })),
    };
  }
  async select(client: string, owner: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([owner, this.#lifetime.signal]);
    await this.requireDesktop().exclusive(() => {
      signal.throwIfAborted();
      const record = this.read();
      if (record?.accounts.some((account) => account.client === client) !== true)
        throw new ProviderFailure('plan-sign-in');
      this.replaceAccountScope();
      this.write({ ...record, active: client });
      return Promise.resolve();
    });
  }
  async signIn(client: string | undefined, owner: AbortSignal): Promise<void> {
    const desktop = this.requireDesktop();
    if (this.#signingIn) throw new ProviderFailure('busy');
    this.#signingIn = true;
    const signal = AbortSignal.any([owner, this.#lifetime.signal, AbortSignal.timeout(300000)]);
    try {
      const record = await desktop.exclusive(() => {
        signal.throwIfAborted();
        let record = this.read();
        if (record === undefined) {
          record = { host: `urn:uuid:${crypto.randomUUID()}`, active: null, accounts: [] };
          this.write(record);
        }
        return Promise.resolve(record);
      });
      const previous = record.accounts.find((account) => account.client === client);
      if (client !== undefined && previous === undefined) throw new ProviderFailure('plan-sign-in');
      const next = await this.exchangeAccount(record.host, previous, signal);
      await desktop.exclusive(() => {
        signal.throwIfAborted();
        const current = this.read();
        const same = current?.accounts.find((account) => account.client === next.client);
        if (current?.host !== record.host || (same !== undefined && same.subject !== next.subject))
          throw new ProviderFailure('plan-sign-in');
        this.replaceAccountScope();
        this.write({
          ...current,
          active: next.client,
          accounts: [...current.accounts.filter((account) => account.client !== next.client), next],
        });
        return Promise.resolve();
      });
    } finally {
      this.#signingIn = false;
    }
  }
  private async exchangeAccount(
    host: string,
    account: PlanAccount | undefined,
    signal: AbortSignal,
    retryClient?: string,
  ): Promise<PlanAccount> {
    signal.throwIfAborted();
    const selected = retryClient ?? account?.client;
    const request = await signInRequest(host, account, selected);
    const callback = await this.requireDesktop().authorize(request.state, request.url, signal);
    const { code, issued } = registrationCallback(callback.params, request.state, selected);
    let tokens: Awaited<ReturnType<typeof tokenRequest>>;
    try {
      tokens = await tokenRequest(
        this.fetch,
        {
          grant_type: 'authorization_code',
          client_id: issued,
          code,
          code_verifier: request.verifier,
          redirect_uri: callback.redirectUri,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof InvalidGrant && retryClient === undefined)
        return this.exchangeAccount(host, account, signal, issued);
      throw error;
    }
    if (tokens.id_token === undefined) throw new ProviderFailure('plan-sign-in');
    const identity = await verifiedIdentity(
      this.fetch,
      tokens.id_token,
      { client: issued, nonce: request.nonce },
      signal,
    );
    return { client: issued, ...identity, grant: nextGrant(tokens, tokens.id_token, this.now()) };
  }
  async signOut(owner: AbortSignal, client = this.state().active): Promise<void> {
    const signal = AbortSignal.any([owner, this.#lifetime.signal]);
    await this.requireDesktop().exclusive(async () => {
      signal.throwIfAborted();
      const record = this.read(),
        account = record?.accounts.find((candidate) => candidate.client === client);
      if (record?.active !== client || account?.grant === undefined) return;
      this.replaceAccountScope();
      const refresh = account.grant.refresh;
      try {
        if (refresh !== undefined) {
          const result = await this.fetch(oauth.revoke, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: refresh,
              token_type_hint: 'refresh_token',
              client_id: account.client,
            }).toString(),
            signal,
          });
          if (!result.ok) throw new ProviderFailure('plan-revoke');
        }
      } catch {
        throw new ProviderFailure('plan-revoke');
      } finally {
        delete account.grant;
        this.write(record);
      }
    });
  }
  private async authorize(client: string | null, signal: AbortSignal): Promise<string> {
    return this.requireDesktop().exclusive(async () => {
      signal.throwIfAborted();
      const record = this.read(),
        account = record?.accounts.find((candidate) => candidate.client === client);
      if (record?.active !== client || account?.grant === undefined)
        throw new ProviderFailure('plan-sign-in');
      if (!allowedPlan(account)) throw new ProviderFailure('plan-permission');
      if (this.now() + 60000 < account.grant.expires) return account.grant.access;
      const next = await this.refresh(record, account, signal);
      if (!allowedPlan(next) || next.grant === undefined)
        throw new ProviderFailure('plan-permission');
      return next.grant.access;
    });
  }
  private async refresh(
    record: PlanHost,
    account: PlanAccount,
    signal: AbortSignal,
  ): Promise<PlanAccount> {
    const grant = account.grant;
    if (grant?.refresh === undefined) throw new ProviderFailure('plan-sign-in');
    try {
      const tokens = await tokenRequest(
        this.fetch,
        { grant_type: 'refresh_token', client_id: account.client, refresh_token: grant.refresh },
        signal,
      );
      if (tokens.id_token !== undefined) {
        const identity = await verifiedIdentity(
          this.fetch,
          tokens.id_token,
          { client: account.client },
          signal,
        );
        if (identity.subject !== account.subject) throw new InvalidGrant();
      }
      const next = {
        ...account,
        grant: nextGrant(tokens, tokens.id_token ?? grant.idToken, this.now(), grant),
      };
      this.write({
        ...record,
        accounts: record.accounts.map((existing) =>
          existing.client === next.client ? next : existing,
        ),
      });
      return next;
    } catch (error) {
      if (error instanceof InvalidGrant) {
        delete account.grant;
        this.write(record);
      }
      throw error;
    }
  }
  private async request(
    client: string | null,
    url: string,
    owner: AbortSignal | null | undefined,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const signals = [this.#accountScope.signal, this.#lifetime.signal];
    if (owner != null) signals.push(owner);
    const signal = AbortSignal.any(signals),
      access = await this.authorize(client, signal);
    signal.throwIfAborted();
    return this.fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${access}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async list(signal: AbortSignal): Promise<ReturnType<typeof planModelChoices>> {
    const response = await this.request(this.state().active, `${planApi}/models`, signal);
    if (!response.ok) throw await planHttpFailure(response);
    return planModelChoices(await response.json());
  }
  model(id: string): ReturnType<typeof createChatGptPlanModel> {
    this.requireDesktop();
    const state = this.state();
    if (!state.connected) throw new ProviderFailure('plan-sign-in');
    if (!state.ready) throw new ProviderFailure('plan-permission');
    return createChatGptPlanModel(id, (body, signal) =>
      this.request(state.active, `${planApi}/responses`, signal, body),
    );
  }
  dispose(): void {
    this.#lifetime.abort();
    this.#accountScope.abort();
  }
}
