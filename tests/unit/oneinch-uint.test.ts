import { expect } from 'chai';
import { BigNumber, constants } from 'ethers';
import {
  normalizeAddressForComparison,
  parseOneInchUint,
} from '../../src/dex/oneinch-uint';

describe('parseOneInchUint', () => {
  const fieldName = 'test field';

  it('parses canonical decimal uint strings', () => {
    expect(parseOneInchUint('0', { fieldName })).to.deep.equal({
      success: true,
      value: constants.Zero,
    });
    expect(parseOneInchUint('123456789', { fieldName })).to.deep.equal({
      success: true,
      value: BigNumber.from('123456789'),
    });
  });

  it('rejects zero-padded decimal strings at this layer (callers pre-normalize)', () => {
    const result = parseOneInchUint('0123', { fieldName });
    expect(result).to.deep.equal({
      success: false,
      error: 'test field must be a decimal uint string',
    });
  });

  it('rejects malformed strings with the default or overridden message', () => {
    expect(parseOneInchUint('1e18', { fieldName })).to.deep.equal({
      success: false,
      error: 'test field must be a decimal uint string',
    });
    expect(
      parseOneInchUint('not-a-number', {
        fieldName,
        invalidStringError: 'custom invalid string',
      })
    ).to.deep.equal({ success: false, error: 'custom invalid string' });
  });

  it('accepts hex strings only when allowHexString is set', () => {
    expect(
      parseOneInchUint('0xff', { fieldName, allowHexString: true })
    ).to.deep.equal({ success: true, value: BigNumber.from(255) });
    expect(parseOneInchUint('0xff', { fieldName })).to.deep.equal({
      success: false,
      error: 'test field must be a decimal uint string',
    });
    expect(
      parseOneInchUint('0x', { fieldName, allowHexString: true })
    ).to.deep.equal({
      success: false,
      error: 'test field must be a decimal or hex uint string',
    });
  });

  it('treats empty and missing values per emptyAsZero', () => {
    for (const empty of [undefined, null, '']) {
      expect(
        parseOneInchUint(empty, { fieldName, emptyAsZero: true })
      ).to.deep.equal({ success: true, value: constants.Zero });
      expect(parseOneInchUint(empty, { fieldName })).to.deep.equal({
        success: false,
        error: 'test field must be a decimal uint string',
      });
    }
  });

  it('enforces requireString against non-string inputs', () => {
    expect(
      parseOneInchUint(123, { fieldName, requireString: true })
    ).to.deep.equal({
      success: false,
      error: 'test field must be a decimal uint string',
    });
    expect(parseOneInchUint(123, { fieldName })).to.deep.equal({
      success: true,
      value: BigNumber.from(123),
    });
  });

  it('validates plain numbers as non-negative safe integers', () => {
    expect(parseOneInchUint(-1, { fieldName })).to.deep.equal({
      success: false,
      error: 'test field must be a non-negative safe integer',
    });
    expect(parseOneInchUint(1.5, { fieldName })).to.deep.equal({
      success: false,
      error: 'test field must be a non-negative safe integer',
    });
    expect(
      parseOneInchUint(Number.MAX_SAFE_INTEGER + 1, {
        fieldName,
        invalidNumberError: 'custom invalid number',
      })
    ).to.deep.equal({ success: false, error: 'custom invalid number' });
  });

  it('passes BigNumber values through with sign and range checks', () => {
    const value = BigNumber.from(42);
    expect(parseOneInchUint(value, { fieldName })).to.deep.equal({
      success: true,
      value,
    });
    expect(parseOneInchUint(BigNumber.from(-1), { fieldName })).to.deep.equal({
      success: false,
      error: 'test field must be a non-negative uint',
    });
    expect(
      parseOneInchUint(BigNumber.from(-1), {
        fieldName,
        negativeBigNumberError: 'custom negative',
      })
    ).to.deep.equal({ success: false, error: 'custom negative' });
    expect(
      parseOneInchUint(constants.MaxUint256.add(1), { fieldName })
    ).to.deep.equal({ success: false, error: 'test field exceeds uint256' });
  });

  it('rejects uint256 overflow for string inputs', () => {
    expect(
      parseOneInchUint(constants.MaxUint256.add(1).toString(), { fieldName })
    ).to.deep.equal({ success: false, error: 'test field exceeds uint256' });
  });

  it('rejects objects and booleans as invalid strings', () => {
    for (const value of [{}, [], true, Symbol('x')]) {
      expect(parseOneInchUint(value, { fieldName })).to.deep.equal({
        success: false,
        error: 'test field must be a decimal uint string',
      });
    }
  });
});

describe('normalizeAddressForComparison', () => {
  it('lowercases valid addresses regardless of input casing', () => {
    const checksummed = '0x1111111254EEB25477B68fb85Ed929f73A960582';
    expect(normalizeAddressForComparison(checksummed)).to.equal(
      checksummed.toLowerCase()
    );
    expect(normalizeAddressForComparison(checksummed.toLowerCase())).to.equal(
      checksummed.toLowerCase()
    );
  });

  it('returns undefined for invalid or non-string inputs', () => {
    for (const value of ['', '0xzz', 'not-an-address', 123, null, undefined]) {
      expect(normalizeAddressForComparison(value)).to.equal(undefined);
    }
  });

  it('returns undefined for bad-checksum addresses', () => {
    expect(
      normalizeAddressForComparison(
        '0x1111111254EEB25477B68fb85Ed929f73A960583'
      )
    ).to.equal(undefined);
  });
});
