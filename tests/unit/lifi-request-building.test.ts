import { expect } from 'chai';
import { ethers } from 'ethers';
import { buildLifiQuoteUrl } from '../../src/dex/lifi';

describe('LI.FI quote request building', () => {
  const chainId = 8453;
  const collateral = '0x1111111111111111111111111111111111111111';
  const quoteToken = '0x2222222222222222222222222222222222222222';
  const taker = '0x3333333333333333333333333333333333333333';
  const fromAmount = '1000000';

  it('builds callback-safe quote requests', () => {
    const url = new URL(
      buildLifiQuoteUrl({
        config: {
          mode: 'canary',
          apiBaseUrl: 'https://li.quest/v1/',
          allowExchanges: ['Uniswap'],
          defaultSlippage: 0.005,
        },
        request: {
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount,
          fromAddress: taker,
          toAddress: taker,
        },
      })
    );

    expect(url.origin + url.pathname).to.equal('https://li.quest/v1/quote');
    expect(url.searchParams.get('fromChain')).to.equal(String(chainId));
    expect(url.searchParams.get('toChain')).to.equal(String(chainId));
    expect(url.searchParams.get('skipSimulation')).to.equal('true');
    expect(url.searchParams.get('allowDestinationCall')).to.equal('false');
    expect(url.searchParams.get('denyBridges')).to.equal('all');
    expect(url.searchParams.get('allowExchanges')).to.equal('uniswap');
  });

  it('rejects unsafe LI.FI quote request shapes before building URLs', () => {
    const base = {
      config: {
        mode: 'canary' as const,
        apiBaseUrl: 'https://li.quest/v1/',
        allowExchanges: ['uniswap'],
        defaultSlippage: 0.005,
      },
      request: {
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        fromAddress: taker,
        toAddress: taker,
      },
    };

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: { ...base.request, chainId: 0 },
      })
    ).to.throw('LI.FI request.chainId must be a positive integer');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: { ...base.request, fromToken: 'not-an-address' },
      })
    ).to.throw('LI.FI request.fromToken must be an address');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          toToken: ethers.constants.AddressZero,
        },
      })
    ).to.throw('LI.FI request.toToken cannot be zero address');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: { ...base.request, fromAmount: '0' },
      })
    ).to.throw(
      'LI.FI request.fromAmount must be a positive decimal integer string'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: { ...base.request, fromAmount: '1.5' },
      })
    ).to.throw(
      'LI.FI request.fromAmount must be a positive decimal integer string'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          toAddress: '0x6666666666666666666666666666666666666666',
        },
      })
    ).to.throw(
      'LI.FI request.fromAddress and toAddress must both be the taker address'
    );

    const lowerCollateral = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const lowerQuoteToken = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const lowerTaker = '0xcccccccccccccccccccccccccccccccccccccccc';
    const url = new URL(
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          fromToken: lowerCollateral,
          toToken: lowerQuoteToken,
          fromAddress: lowerTaker,
          toAddress: lowerTaker,
        },
      })
    );
    expect(url.searchParams.get('fromToken')).to.equal(
      ethers.utils.getAddress(lowerCollateral)
    );
    expect(url.searchParams.get('toToken')).to.equal(
      ethers.utils.getAddress(lowerQuoteToken)
    );
    expect(url.searchParams.get('fromAddress')).to.equal(
      ethers.utils.getAddress(lowerTaker)
    );
    expect(url.searchParams.get('toAddress')).to.equal(
      ethers.utils.getAddress(lowerTaker)
    );
  });

  it('normalizes request-level exchange filter overrides before building quote requests', () => {
    const url = new URL(
      buildLifiQuoteUrl({
        config: {
          mode: 'canary',
          apiBaseUrl: 'https://li.quest/v1/',
          allowExchanges: ['sushiswap'],
          defaultSlippage: 0.005,
        },
        request: {
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount,
          fromAddress: taker,
          toAddress: taker,
          allowExchanges: ['Uniswap'],
          preferExchanges: ['KyberSwap'],
        },
      })
    );

    expect(url.searchParams.get('allowExchanges')).to.equal('uniswap');
    expect(url.searchParams.get('preferExchanges')).to.equal('kyberswap');
  });

  it('rejects duplicate request-level exchange filters across allow and prefer', () => {
    expect(() =>
      buildLifiQuoteUrl({
        config: {
          mode: 'canary',
          apiBaseUrl: 'https://li.quest/v1/',
          defaultSlippage: 0.005,
        },
        request: {
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount,
          fromAddress: taker,
          toAddress: taker,
          allowExchanges: ['Uniswap'],
          preferExchanges: ['uniswap'],
        },
      })
    ).to.throw(
      'LI.FI exchange filter uniswap cannot appear in both allowExchanges and preferExchanges'
    );
  });

  it('validates LI.FI integrator values before building quote requests', () => {
    const base = {
      config: {
        mode: 'canary' as const,
        apiBaseUrl: 'https://li.quest/v1/',
        allowExchanges: ['uniswap'],
        defaultSlippage: 0.005,
        integrator: 'ajna.keeper-01',
      },
      request: {
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        fromAddress: taker,
        toAddress: taker,
      },
    };

    const configUrl = new URL(buildLifiQuoteUrl(base));
    expect(configUrl.searchParams.get('integrator')).to.equal('ajna.keeper-01');

    const requestUrl = new URL(
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          integrator: 'ajna_override',
        },
      })
    );
    expect(requestUrl.searchParams.get('integrator')).to.equal('ajna_override');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        config: {
          ...base.config,
          integrator: 'x'.repeat(24),
        },
      })
    ).to.throw(
      'dex.lifi.integrator must be 1-23 characters and contain only letters, numbers, hyphens, underscores, or dots'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          integrator: 'ajna keeper',
        },
      })
    ).to.throw(
      'LI.FI request.integrator must be 1-23 characters and contain only letters, numbers, hyphens, underscores, or dots'
    );
  });

  it('rejects unsafe request-level LI.FI slippage and price-impact overrides', () => {
    const base = {
      config: {
        mode: 'canary' as const,
        apiBaseUrl: 'https://li.quest/v1/',
        allowExchanges: ['uniswap'],
        defaultSlippage: 0.005,
        maxPriceImpact: 0.01,
      },
      request: {
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        fromAddress: taker,
        toAddress: taker,
      },
    };

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          slippage: 0,
        },
      })
    ).to.throw(
      'dex.lifi.defaultSlippage must be greater than 0 and at most 0.5'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          maxPriceImpact: Number.POSITIVE_INFINITY,
        },
      })
    ).to.throw(
      'dex.lifi.maxPriceImpact must be greater than 0 and at most 0.5'
    );

    const url = new URL(
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          maxPriceImpact: 0.02,
        },
      })
    );
    expect(url.searchParams.get('maxPriceImpact')).to.equal('0.02');
  });

  it('rejects fee-collection exchange filters in quote requests', () => {
    expect(() =>
      buildLifiQuoteUrl({
        config: {
          mode: 'canary',
          apiBaseUrl: 'https://li.quest/v1/',
          allowExchanges: ['feeCollection'],
          defaultSlippage: 0.005,
        },
        request: {
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount,
          fromAddress: taker,
          toAddress: taker,
        },
      })
    ).to.throw(
      'dex.lifi.allowExchanges cannot use unsupported LI.FI filter keyword'
    );
  });

  it('rejects request-level broad and unsupported exchange filter overrides', () => {
    const base = {
      config: {
        mode: 'canary' as const,
        apiBaseUrl: 'https://li.quest/v1/',
        allowExchanges: ['uniswap'],
        defaultSlippage: 0.005,
      },
      request: {
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        fromAddress: taker,
        toAddress: taker,
      },
    };

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          allowExchanges: ['all'],
        },
      })
    ).to.throw('dex.lifi.allowExchanges cannot use broad LI.FI filter keyword');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          allowExchanges: ['none'],
        },
      })
    ).to.throw('dex.lifi.allowExchanges cannot use broad LI.FI filter keyword');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          preferExchanges: ['[]'],
        },
      })
    ).to.throw(
      'dex.lifi.preferExchanges cannot use broad LI.FI filter keyword'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          denyExchanges: ['feeCollection'],
        },
      })
    ).to.throw(
      'dex.lifi.denyExchanges cannot use unsupported LI.FI filter keyword'
    );
  });
});
