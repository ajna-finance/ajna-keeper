import type { LifiProductionDexConfig } from '../../src/config';

const concreteAllowlist = {
  mode: 'production',
  allowExchanges: ['uniswap'],
  callTargetAllowlist: {
    8453: ['0x1111111111111111111111111111111111111111'],
  },
  approvalSpenderAllowlist: {
    8453: ['0x2222222222222222222222222222222222222222'],
  },
  selectorAllowlist: {
    8453: {
      '0x1111111111111111111111111111111111111111': ['0xabcdef12'],
    },
  },
} satisfies LifiProductionDexConfig;

const reviewedBroad = {
  mode: 'production',
  exchangePolicy: 'reviewed_broad',
  callTargetAllowlist: {
    8453: ['0x1111111111111111111111111111111111111111'],
  },
  approvalSpenderAllowlist: {
    8453: ['0x2222222222222222222222222222222222222222'],
  },
  selectorAllowlist: {
    8453: {
      '0x1111111111111111111111111111111111111111': ['0xabcdef12'],
    },
  },
} satisfies LifiProductionDexConfig;

const explicitConcreteAllowlist = {
  mode: 'production',
  exchangePolicy: 'concrete_allowlist',
  allowExchanges: ['uniswap'],
  callTargetAllowlist: concreteAllowlist.callTargetAllowlist,
  approvalSpenderAllowlist: concreteAllowlist.approvalSpenderAllowlist,
  selectorAllowlist: concreteAllowlist.selectorAllowlist,
} satisfies LifiProductionDexConfig;

// @ts-expect-error concrete production config must include allowExchanges.
const missingConcreteAllowlist: LifiProductionDexConfig = {
  mode: 'production',
  callTargetAllowlist: concreteAllowlist.callTargetAllowlist,
  approvalSpenderAllowlist: concreteAllowlist.approvalSpenderAllowlist,
  selectorAllowlist: concreteAllowlist.selectorAllowlist,
};

// @ts-expect-error reviewed-broad production config must omit allowExchanges.
const reviewedBroadWithAllowlist: LifiProductionDexConfig = {
  mode: 'production',
  exchangePolicy: 'reviewed_broad',
  allowExchanges: ['uniswap'],
  callTargetAllowlist: reviewedBroad.callTargetAllowlist,
  approvalSpenderAllowlist: reviewedBroad.approvalSpenderAllowlist,
  selectorAllowlist: reviewedBroad.selectorAllowlist,
};

void concreteAllowlist;
void reviewedBroad;
void explicitConcreteAllowlist;
void missingConcreteAllowlist;
void reviewedBroadWithAllowlist;
