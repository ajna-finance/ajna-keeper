import { BigNumber, providers, Wallet } from 'ethers';
import { promises as fs } from 'fs';
import { password } from '@inquirer/prompts';
import { FungiblePool } from '@ajna-finance/sdk';
import { KeeperConfig } from './config';
import { logger } from './logging';
import { JsonRpcProvider } from './provider';

export type RequireFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
interface UtilsType {
  addAccountFromKeystore: (
    keystorePath: string,
    provider: providers.JsonRpcProvider
  ) => Promise<Wallet>;
  getProviderAndSigner: (
    keystorePath: string,
    rpcUrl: string
  ) => Promise<{ provider: providers.JsonRpcProvider; signer: Wallet }>;
  askPassword: () => Promise<string>;
}

let Utils: UtilsType;

/**
 * Resolve the keystore password with a three-tier fallback:
 *
 *   1. `KEYSTORE_PASSWORD_FILE` — path to a file whose contents are the
 *      password. Trailing newlines (LF or CRLF, any number) are stripped so
 *      secrets written via `echo > file` or `op read > file` work. Empty
 *      or unreadable files throw a clear error rather than silently
 *      falling through.
 *   2. `KEYSTORE_PASSWORD` — password directly in an env var.
 *   3. Interactive prompt — existing behavior; preserved so tmux/screen
 *      deployments aren't broken.
 *
 * Having BOTH env vars set at once is refused rather than silently picking
 * one — stale-rotation bugs are a common incident pattern otherwise.
 * Empty-string values (`KEYSTORE_PASSWORD=""`, `KEYSTORE_PASSWORD_FILE=""`)
 * are treated as unset; operators who meant to clear a variable shouldn't
 * accidentally authorize an empty password.
 *
 * The password value itself is NEVER logged. Only the source is mentioned
 * in info-level logs so operators can confirm the right injection path
 * was picked.
 */
export async function askPassword() {
  const rawFilePath = process.env.KEYSTORE_PASSWORD_FILE;
  const rawEnvPassword = process.env.KEYSTORE_PASSWORD;
  const filePath = rawFilePath && rawFilePath.length > 0 ? rawFilePath : undefined;
  const envPassword =
    rawEnvPassword && rawEnvPassword.length > 0 ? rawEnvPassword : undefined;

  if (filePath && envPassword) {
    throw new Error(
      'Both KEYSTORE_PASSWORD_FILE and KEYSTORE_PASSWORD are set. ' +
        'Set only one to avoid ambiguity about which source is authoritative.'
    );
  }

  if (filePath) {
    let contents: string;
    try {
      contents = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      throw new Error(
        `Failed to read KEYSTORE_PASSWORD_FILE at ${filePath}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    // Defensive: if the file is world-readable, nudge the operator. Not
    // fatal — some ops environments deliberately tolerate this.
    try {
      const stats = await fs.stat(filePath);
      if (stats.mode & 0o077) {
        logger.warn(
          `KEYSTORE_PASSWORD_FILE ${filePath} has permissions ` +
            `${(stats.mode & 0o777).toString(8)}; recommend chmod 600 (or tighter).`
        );
      }
    } catch {
      /* stat errors are not worth failing on; readFile already succeeded */
    }
    // Strip trailing newlines only (LF, CRLF, any number). Don't use
    // `.trim()` — an operator's password could legitimately end with
    // whitespace we'd silently eat.
    const pswd = contents.replace(/(\r?\n)+$/, '');
    if (pswd.length === 0) {
      throw new Error(
        `KEYSTORE_PASSWORD_FILE at ${filePath} is empty (after stripping ` +
          `trailing newlines). Populate it with the keystore password.`
      );
    }
    logger.info(`Keystore unlock: using KEYSTORE_PASSWORD_FILE=${filePath}`);
    return pswd;
  }

  if (envPassword) {
    logger.info('Keystore unlock: using KEYSTORE_PASSWORD env var');
    return envPassword;
  }

  const pswd = await password({
    message: 'Please enter your keystore password',
    mask: '*',
  });
  return pswd;
}

export async function addAccountFromKeystore(
  keystorePath: string,
  provider: providers.JsonRpcProvider
): Promise<Wallet> {
  // read the keystore file, confirming it exists
  const jsonKeystore = (await fs.readFile(keystorePath)).toString();

  const pswd = await Utils.askPassword();

  try {
    let wallet = Wallet.fromEncryptedJsonSync(jsonKeystore, pswd);
    logger.info(`Loaded wallet with address: ${wallet.address}`);
    return wallet.connect(provider);
  } catch (error) {
    logger.error('Error decrypting keystore:', error);
    throw new Error(
      `Failed to decrypt keystore at ${keystorePath}. Check your keystore password and try again.`
    );
  }
}

export function overrideMulticall(
  fungiblePool: FungiblePool,
  chainConfig: KeeperConfig
): void {
  if (
    chainConfig?.multicallAddress &&
    chainConfig?.multicallBlock !== undefined
  ) {
    fungiblePool.ethcallProvider.multicall3 = {
      address: chainConfig.multicallAddress,
      block: chainConfig.multicallBlock,
    };
  }
}

export async function delay(seconds: number) {
  return new Promise((res) => setTimeout(res, seconds * 1000));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function withGasLimitBuffer(
  estimatedGas: BigNumber,
  basisPoints: number = 13000
): BigNumber {
  return estimatedGas.mul(basisPoints).add(9999).div(10000);
}

export async function estimateGasWithBuffer(
  estimateFn: () => Promise<BigNumber>,
  fallbackGasLimit: BigNumber,
  label: string,
  basisPoints: number = 13000
): Promise<BigNumber> {
  try {
    const estimatedGas = await estimateFn();
    const gasLimit = withGasLimitBuffer(estimatedGas, basisPoints);
    logger.debug(
      `${label} gas estimate: ${estimatedGas.toString()} -> buffered ${gasLimit.toString()}`
    );
    return gasLimit;
  } catch (error) {
    logger.warn(
      `${label} gas estimation failed, using fallback ${fallbackGasLimit.toString()}: ${error}`
    );
    return fallbackGasLimit;
  }
}

function bigToScientific(bn: BigNumber): {
  mantissa: number;
  exponent10: number;
} {
  const bnStr = bn.toString();
  const numbStart = bnStr.startsWith('-') ? 1 : 0;
  const mantissa = parseFloat(
    bnStr.slice(0, numbStart + 1) + '.' + bnStr.slice(numbStart + 1, 14)
  );
  const exponent10 = bnStr.length - (1 + numbStart);
  return { mantissa, exponent10 };
}

export function weiToDecimaled(
  bn: BigNumber,
  tokenDecimals: number = 18
): number {
  const scientific = bigToScientific(bn);
  scientific.exponent10 -= tokenDecimals;
  return parseFloat(scientific.mantissa + 'e' + scientific.exponent10);
}

export function decimaledToWei(
  dec: number,
  tokenDecimals: number = 18
): BigNumber {
  const scientificStr = dec.toExponential();
  const [mantissaStr, exponent10Str] = scientificStr
    .replace('.', '')
    .split('e');
  let weiStrLength = 1;
  if (mantissaStr.includes('.')) weiStrLength += 1;
  if (mantissaStr.startsWith('-')) weiStrLength += 1;
  const exponent10 = parseInt(exponent10Str) + tokenDecimals;
  weiStrLength += exponent10;
  const weiStr = mantissaStr.slice(0, weiStrLength).padEnd(weiStrLength, '0');
  return BigNumber.from(weiStr);
}

export function tokenChangeDecimals(
  tokenWei: BigNumber,
  currDecimals: number,
  targetDecimals: number = 18
) {
  const isNegative = tokenWei.isNegative();
  const absStr = isNegative ? tokenWei.abs().toString() : tokenWei.toString();
  let result: BigNumber;
  if (currDecimals < targetDecimals) {
    const zeroes = '0'.repeat(targetDecimals - currDecimals);
    result = BigNumber.from(absStr + zeroes);
  } else if (currDecimals > targetDecimals) {
    const charsToRemove = currDecimals - targetDecimals;
    if (absStr.length <= charsToRemove) return BigNumber.from(0);
    result = BigNumber.from(absStr.slice(0, -charsToRemove));
  } else {
    result = BigNumber.from(absStr);
  }
  return isNegative ? result.mul(-1) : result;
}

export async function getProviderAndSigner(
  keystorePath: string,
  rpcUrl: string
) {
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = await Utils.addAccountFromKeystore(keystorePath, provider);

  return { provider, signer };
}

export async function arrayFromAsync<T>(
  gen: AsyncGenerator<T>
): Promise<Array<T>> {
  const result: Array<T> = [];
  for await (const elem of gen) {
    result.push(elem);
  }
  return result;
}

/**
 *
 * @param fn Function which should resolve a true value eventually.
 * @param pollingInterval Time between function checks in seconds.
 * @param timeout Time until timeout in seconds.
 */
export const waitForConditionToBeTrue = async (
  fn: () => Promise<boolean>,
  pollingIntervalSeconds: number = 0.2,
  timeoutSeconds: number = 40
) => {
  const startTime = Date.now();
  while (!(await fn())) {
    const timeWaited = (Date.now() - startTime) / 1000;
    if (timeWaited > timeoutSeconds) {
      throw new Error('Timed out before condition became true.');
    }
    await delay(pollingIntervalSeconds);
  }
};

export default Utils = {
  addAccountFromKeystore,
  getProviderAndSigner,
  askPassword,
};
