import { main } from './runner.mts';

const root = process.argv[2];
if (root === undefined) throw new Error('Use pnpm run profile from the repository');
await main(process.argv.slice(3), root);
