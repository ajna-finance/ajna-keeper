import { expect } from 'chai';
import { ethers } from 'ethers';
import { convertWadToTokenDecimalsCeil } from '../../src/erc20';

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
