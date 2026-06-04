import fs from 'fs';
import os from 'os';
import path from 'path';
import { KeeperConfig, readConfigFile } from '../../../src/config';
import {
  buildLifiQuoteUrl,
  DEFAULT_LIFI_API_BASE_URL,
} from '../../../src/dex/lifi';
import {
  LifiRouteCanaryDeps,
  runLifiRouteCanary,
} from '../../../src/dex/lifi/route-canary';

type TestEnv = Record<string, string | undefined>;

export type LifiRouteCanaryTestRun = {
  result: {
    status: number;
    stderr: string;
    stdout: string;
    error?: Error;
  };
  summary?: any;
};

const repoRoot = path.join(__dirname, '../../..');

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

function firstConcreteTool(values: readonly string[] | undefined): string {
  const concrete = (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .find(
      (value) =>
        value.length > 0 &&
        value !== 'all' &&
        value !== 'default' &&
        value !== 'none' &&
        value !== '[]'
    );
  return concrete ?? 'uniswap';
}

function getChainRecord<T>(
  record: { [key: string]: T; [key: number]: T } | undefined,
  chainId: number
): T | undefined {
  if (record === undefined) {
    return undefined;
  }
  return record[chainId] ?? record[String(chainId)];
}

function buildInProcessLifiDeps(params: {
  env: TestEnv;
  config: KeeperConfig | undefined;
  requestsPath: string;
}): LifiRouteCanaryDeps {
  const record = (url: string) => {
    fs.appendFileSync(params.requestsPath, `${JSON.stringify({ url })}\n`);
  };

  return {
    fetchTools: async ({ config }) => {
      const allowExchanges =
        parseCsv(params.env.AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES) ??
        config.allowExchanges;
      const primaryTool = firstConcreteTool(allowExchanges);
      const tools = allowExchanges?.some(
        (value) => value.trim().toLowerCase() === 'all'
      )
        ? ['uniswap', 'sushiswap']
        : [primaryTool];
      const baseUrl = config.apiBaseUrl ?? DEFAULT_LIFI_API_BASE_URL;
      record(`${baseUrl}/tools`);
      return { exchanges: tools.map((key) => ({ key })) };
    },
    fetchQuote: async ({ config, request }) => {
      const quoteUrl = buildLifiQuoteUrl({ config, request });
      record(quoteUrl);
      const callTarget =
        parseCsv(
          params.env.AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST
        )?.[0] ??
        getChainRecord(
          params.config?.dex?.lifi?.callTargetAllowlist,
          request.chainId
        )?.[0];
      const approvalSpender =
        parseCsv(
          params.env.AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST
        )?.[0] ??
        getChainRecord(
          params.config?.dex?.lifi?.approvalSpenderAllowlist,
          request.chainId
        )?.[0];
      const selectorPolicy =
        params.env.AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON !== undefined
          ? JSON.parse(
              params.env.AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON
            )
          : params.config?.dex?.lifi?.mode === 'production'
            ? getChainRecord(
                params.config.dex.lifi.selectorAllowlist,
                request.chainId
              )
            : undefined;
      const selector =
        callTarget !== undefined
          ? selectorPolicy?.[callTarget]?.[0]
          : undefined;
      if (
        callTarget === undefined ||
        approvalSpender === undefined ||
        selector === undefined
      ) {
        throw new Error('test LI.FI quote fixture is missing policy fields');
      }
      const tool = firstConcreteTool(config.allowExchanges);
      return {
        status: 200,
        data: {
          type: 'swap',
          tool,
          action: {
            fromToken: {
              address: request.fromToken,
              chainId: request.chainId,
            },
            toToken: {
              address: request.toToken,
              chainId: request.chainId,
            },
            fromAmount: request.fromAmount,
            fromChainId: request.chainId,
            toChainId: request.chainId,
            fromAddress: request.fromAddress,
            toAddress: request.toAddress,
            destinationCall: false,
          },
          estimate: {
            approvalAddress: approvalSpender,
            fromAmount: request.fromAmount,
            toAmount: '1250000',
            toAmountMin: '1200000',
          },
          transactionRequest: {
            to: callTarget,
            data: `${selector}00000000`,
            value: '0',
            from: request.fromAddress,
            chainId: request.chainId,
          },
        },
      };
    },
  };
}

function getConfigArg(args: readonly string[]): string | undefined {
  const configIndex = args.indexOf('--config');
  return configIndex >= 0 ? args[configIndex + 1] : undefined;
}

export async function runLifiRouteCanaryTest(
  env: TestEnv = {},
  args: string[] = []
): Promise<LifiRouteCanaryTestRun> {
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lifi-route-canary-')
  );
  const outputPath = path.join(outputDir, 'summary.json');
  const runEnv: TestEnv = {
    PATH: process.env.PATH ?? '',
    HOME: os.tmpdir(),
    TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.json'),
    AJNA_AGENT_LIFI_CANARY_OUTPUT_PATH: outputPath,
    ...env,
  };
  try {
    const configPath = getConfigArg(args);
    const config =
      configPath !== undefined ? await readConfigFile(configPath) : undefined;
    const deps = runEnv.AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH
      ? buildInProcessLifiDeps({
          env: runEnv,
          config,
          requestsPath: runEnv.AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH,
        })
      : undefined;
    const canaryResult = await runLifiRouteCanary({
      env: runEnv,
      config,
      deps,
    });
    const stdout = `${JSON.stringify(canaryResult.summary, null, 2)}\n`;
    fs.writeFileSync(outputPath, stdout);
    return {
      result: {
        status: canaryResult.exitCode,
        stderr: '',
        stdout,
      },
      summary: canaryResult.summary,
    };
  } catch (error) {
    const stderr = `LI.FI canary failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`;
    return {
      result: {
        status: 1,
        stderr,
        stdout: '',
      },
      summary: undefined,
    };
  }
}

export function writeNoContactAxiosMock(
  mockDir: string,
  _message: string
): {
  requestsPath: string;
} {
  return { requestsPath: path.join(mockDir, 'requests.jsonl') };
}

export function writeKeeperConfig(params: {
  dir: string;
  mode: 'canary' | 'production';
  takerAddress: string;
  callTarget: string;
  approvalSpender: string;
  selector: string;
  chainId?: number;
  apiBaseUrl?: string;
  allowExchanges?: string[];
  allowBroadExchangeFilters?: boolean;
  extraChainId?: number;
  incompleteExtraChainId?: number;
}): string {
  const configPath = path.join(params.dir, 'keeper-config.json');
  const chainId = params.chainId ?? 8453;
  const callTargetAllowlist: Record<number, string[]> = {
    [chainId]: [params.callTarget],
  };
  const approvalSpenderAllowlist: Record<number, string[]> = {
    [chainId]: [params.approvalSpender],
  };
  const selectorAllowlist: Record<number, Record<string, string[]>> = {
    [chainId]: { [params.callTarget]: [params.selector] },
  };
  if (params.extraChainId !== undefined) {
    callTargetAllowlist[params.extraChainId] = [params.callTarget];
    approvalSpenderAllowlist[params.extraChainId] = [params.approvalSpender];
    selectorAllowlist[params.extraChainId] = {
      [params.callTarget]: [params.selector],
    };
  }
  if (params.incompleteExtraChainId !== undefined) {
    callTargetAllowlist[params.incompleteExtraChainId] = [params.callTarget];
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        network: {
          rpcUrl: 'http://localhost:8545',
          subgraph: { url: 'http://example-subgraph' },
        },
        signer: { keystore: '/tmp/keeper.json' },
        runtime: { logLevel: 'debug', delayBetweenRuns: 1 },
        ajna: {
          erc20PoolFactory: '0x0000000000000000000000000000000000000001',
          erc721PoolFactory: '0x0000000000000000000000000000000000000002',
          poolUtils: '0x0000000000000000000000000000000000000003',
          positionManager: '0x0000000000000000000000000000000000000004',
          ajnaToken: '0x0000000000000000000000000000000000000005',
        },
        manual: { pools: [] },
        takers: {
          factory: '0x0000000000000000000000000000000000000006',
          contracts: { Lifi: params.takerAddress },
        },
        dex: {
          lifi: {
            mode: params.mode,
            ...(params.apiBaseUrl ? { apiBaseUrl: params.apiBaseUrl } : {}),
            allowExchanges: params.allowExchanges ?? ['uniswap'],
            ...(params.allowBroadExchangeFilters !== undefined
              ? {
                  allowBroadExchangeFilters: params.allowBroadExchangeFilters,
                }
              : {}),
            callTargetAllowlist,
            approvalSpenderAllowlist,
            selectorAllowlist,
          },
        },
      },
      null,
      2
    )
  );
  return configPath;
}
