import { BigNumber, providers } from 'ethers';
import { KeeperConfig } from './config';
import { getResilientReadGasPrice } from './read-rpc';
import subgraph, {
  GetBucketTakeLPAwardsResponse,
  GetChainwideLiquidationAuctionsResponse,
  GetLiquidationResponse,
  GetLoanResponse,
  GetMeaningfulBucketResponse,
  GetUnsettledAuctionsResponse,
} from './subgraph';

export type SubgraphTransportConfig = Pick<
  KeeperConfig,
  'subgraphUrl' | 'subgraphFallbackUrls'
>;

export type ReadRpcTransportConfig = Pick<
  KeeperConfig,
  'ethRpcUrl' | 'readRpcUrls'
>;

export type DiscoveryReadTransportConfig = SubgraphTransportConfig &
  ReadRpcTransportConfig;

type ExpectedChainIdResolver = () => Promise<number | undefined>;

export interface SubgraphReader {
  readonly cacheKey: string;
  getLoans(poolAddress: string): Promise<GetLoanResponse>;
  getLiquidations(
    poolAddress: string,
    minCollateral: number
  ): Promise<GetLiquidationResponse>;
  getHighestMeaningfulBucket(
    poolAddress: string,
    minDeposit: string
  ): Promise<GetMeaningfulBucketResponse>;
  getUnsettledAuctions(poolAddress: string): Promise<GetUnsettledAuctionsResponse>;
  getChainwideLiquidationAuctions(
    pageSize?: number,
    maxPages?: number
  ): Promise<GetChainwideLiquidationAuctionsResponse>;
  getBucketTakeLPAwards(
    poolAddress: string,
    signerAddress: string,
    sinceBlockTimestamp: string,
    afterId: string
  ): Promise<GetBucketTakeLPAwardsResponse>;
}

export interface ReadRpc {
  getGasPrice(): Promise<BigNumber>;
}

export interface DiscoveryReadTransports {
  subgraph: SubgraphReader;
  readRpc: ReadRpc;
}

export type WithSubgraph<T extends object> = T & {
  subgraph: SubgraphReader;
};

export type SubgraphConfigInput<T extends object> =
  | WithSubgraph<T>
  | (T & SubgraphTransportConfig);

function getSubgraphCacheKey(config: SubgraphTransportConfig): string {
  return `${config.subgraphUrl}|${(config.subgraphFallbackUrls ?? []).join(',')}`;
}

export function createSubgraphReader(
  config: SubgraphTransportConfig
): SubgraphReader {
  return {
    cacheKey: getSubgraphCacheKey(config),
    getLoans(poolAddress) {
      return subgraph.getLoans(config.subgraphUrl, poolAddress, {
        fallbackUrls: config.subgraphFallbackUrls,
      });
    },
    getLiquidations(poolAddress, minCollateral) {
      return subgraph.getLiquidations(
        config.subgraphUrl,
        poolAddress,
        minCollateral,
        {
          fallbackUrls: config.subgraphFallbackUrls,
        }
      );
    },
    getHighestMeaningfulBucket(poolAddress, minDeposit) {
      return subgraph.getHighestMeaningfulBucket(
        config.subgraphUrl,
        poolAddress,
        minDeposit,
        {
          fallbackUrls: config.subgraphFallbackUrls,
        }
      );
    },
    getUnsettledAuctions(poolAddress) {
      return subgraph.getUnsettledAuctions(config.subgraphUrl, poolAddress, {
        fallbackUrls: config.subgraphFallbackUrls,
      });
    },
    getChainwideLiquidationAuctions(pageSize, maxPages) {
      return subgraph.getChainwideLiquidationAuctions(
        config.subgraphUrl,
        pageSize,
        maxPages,
        {
          fallbackUrls: config.subgraphFallbackUrls,
        }
      );
    },
    getBucketTakeLPAwards(
      poolAddress,
      signerAddress,
      sinceBlockTimestamp,
      afterId
    ) {
      return subgraph.getBucketTakeLPAwards(
        config.subgraphUrl,
        poolAddress,
        signerAddress,
        sinceBlockTimestamp,
        afterId,
        {
          fallbackUrls: config.subgraphFallbackUrls,
        }
      );
    },
  };
}

export function resolveSubgraphConfig<T extends object>(
  config: SubgraphConfigInput<T>
): WithSubgraph<T> {
  if ('subgraph' in config) {
    return config;
  }

  return {
    ...config,
    subgraph: createSubgraphReader(config),
  };
}

export function createReadRpcTransport(
  config: ReadRpcTransportConfig,
  primaryProvider?: providers.Provider,
  expectedChainIdResolver?: ExpectedChainIdResolver
): ReadRpc {
  return {
    async getGasPrice() {
      return getResilientReadGasPrice({
        config,
        primaryProvider,
        expectedChainId: expectedChainIdResolver
          ? await expectedChainIdResolver()
          : undefined,
      });
    },
  };
}

export function createDiscoveryReadTransports(
  config: DiscoveryReadTransportConfig,
  primaryProvider?: providers.Provider,
  expectedChainIdResolver?: ExpectedChainIdResolver
): DiscoveryReadTransports {
  return {
    subgraph: createSubgraphReader(config),
    readRpc: createReadRpcTransport(
      config,
      primaryProvider,
      expectedChainIdResolver
    ),
  };
}
