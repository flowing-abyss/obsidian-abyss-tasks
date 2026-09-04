import type { ApplicationValue } from '../application/valid';
import type { DomainValue } from '../domain/value';
export interface InfrastructureValue {
  readonly application: ApplicationValue;
  readonly domain: DomainValue;
}
