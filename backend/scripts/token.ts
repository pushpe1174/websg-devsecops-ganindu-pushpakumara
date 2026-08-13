/**
 * Prints an access token for calling the API by hand.
 *
 *   npm run token -- user-a
 *
 * The user must exist in src/config/users.ts; the tenant comes from there.
 */
import { assertConfig, config } from '../src/config/index.ts';
import { tenantOf } from '../src/config/users.ts';
import { signToken } from '../src/infra/tokens.ts';

const [userId = 'user-a'] = process.argv.slice(2);

assertConfig(config);

const tenantId = tenantOf(userId);
if (!tenantId) throw new Error(`unknown user: ${userId}`);

const token = await signToken(config, userId, '12h');

console.error(`${userId} -> ${tenantId}`);
console.log(token);
