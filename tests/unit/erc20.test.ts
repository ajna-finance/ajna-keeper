import { expect } from 'chai';
import { ethers } from 'ethers';
import {
  convertWadToTokenDecimals,
  convertWadToTokenDecimalsCeil,
} from '../../src/erc20';

describe('convertWadToTokenDecimals', () => {
  it('keeps 18-decimal collateral unchanged for exact-input external routes', () => {
    expect(
      convertWadToTokenDecimals(ethers.utils.parseEther('1.23456789'), 18).eq(
        ethers.utils.parseEther('1.23456789')
      )
    ).to.equal(true);
  });

  it('rounds down WAD collateral to 8-decimal exact-input token units', () => {
    expect(
      convertWadToTokenDecimals(
        ethers.BigNumber.from('1234567891234567890'),
        8
      ).toString()
    ).to.equal('123456789');
  });

  it('rounds down WAD collateral to 6-decimal exact-input token units', () => {
    expect(
      convertWadToTokenDecimals(
        ethers.BigNumber.from('1234567891234567890'),
        6
      ).toString()
    ).to.equal('1234567');
  });

  it('scales WAD collateral up for higher-decimal exact-input token units', () => {
    expect(
      convertWadToTokenDecimals(ethers.utils.parseEther('1.5'), 20).toString()
    ).to.equal('150000000000000000000');
  });
});

describe('convertWadToTokenDecimalsCeil', () => {
  it('rounds up when scaling WAD amounts down to lower-decimal tokens', () => {
    expect(
      convertWadToTokenDecimalsCeil(
        ethers.BigNumber.from('1500000000000'),
        6
      ).toString()
    ).to.equal('2');
  });

  it('keeps exact lower-decimal conversions unchanged', () => {
    expect(
      convertWadToTokenDecimalsCeil(ethers.utils.parseEther('1'), 6).toString()
    ).to.equal('1000000');
  });

  it('scales WAD amounts up for higher-decimal tokens', () => {
    expect(
      convertWadToTokenDecimalsCeil(ethers.utils.parseEther('1'), 20).toString()
    ).to.equal('100000000000000000000');
  });
});
