import { expect } from 'chai';
import { constants, utils } from 'ethers';
import {
  bigIntStringGreater,
  parseBigDecimalToWad,
  subtractSecondsClamped,
} from '../rewards/collect-lp';

describe('parseBigDecimalToWad', () => {
  it('returns zero for empty string', () => {
    expect(parseBigDecimalToWad('').eq(constants.Zero)).to.be.true;
  });

  it("returns zero for '0'", () => {
    expect(parseBigDecimalToWad('0').eq(constants.Zero)).to.be.true;
  });

  it("returns zero for '0.0'", () => {
    expect(parseBigDecimalToWad('0.0').eq(constants.Zero)).to.be.true;
  });

  it("returns zero for '0.000000000000000000'", () => {
    expect(parseBigDecimalToWad('0.000000000000000000').eq(constants.Zero)).to
      .be.true;
  });

  it("returns zero for '-0'", () => {
    expect(parseBigDecimalToWad('-0').eq(constants.Zero)).to.be.true;
  });

  it('parses a canonical 18-decimal value into WAD BigNumber', () => {
    expect(
      parseBigDecimalToWad('123.456000000000000000').toString()
    ).to.equal(utils.parseUnits('123.456', 18).toString());
  });

  it('parses an integer string without decimal point', () => {
    expect(parseBigDecimalToWad('42').toString()).to.equal(
      utils.parseUnits('42', 18).toString()
    );
  });

  it('throws on negative values so quarantine catches schema drift', () => {
    expect(() => parseBigDecimalToWad('-1.5')).to.throw(/negative/);
    expect(() => parseBigDecimalToWad('-0.000000000000000001')).to.throw(
      /negative/
    );
  });

  it('throws on malformed input', () => {
    expect(() => parseBigDecimalToWad('abc')).to.throw();
    expect(() => parseBigDecimalToWad('1.2.3')).to.throw();
  });

  it('throws on more than 18 fractional digits', () => {
    expect(() => parseBigDecimalToWad('1.1234567890123456789')).to.throw();
  });

  it('throws on scientific notation', () => {
    expect(() => parseBigDecimalToWad('1e18')).to.throw();
  });
});

describe('bigIntStringGreater', () => {
  it('returns true when a > b', () => {
    expect(bigIntStringGreater('100', '99')).to.be.true;
  });

  it('returns false when a == b', () => {
    expect(bigIntStringGreater('100', '100')).to.be.false;
  });

  it('returns false when a < b', () => {
    expect(bigIntStringGreater('99', '100')).to.be.false;
  });

  it('handles large timestamps beyond Number.MAX_SAFE_INTEGER', () => {
    const big = '99999999999999999999';
    const bigger = '100000000000000000000';
    expect(bigIntStringGreater(bigger, big)).to.be.true;
  });

  it('returns false without throwing on malformed inputs', () => {
    expect(bigIntStringGreater('abc', '100')).to.be.false;
    expect(bigIntStringGreater('100', 'abc')).to.be.false;
    expect(bigIntStringGreater('', '')).to.be.false;
  });

  it("treats '0' correctly as the seed cursor", () => {
    expect(bigIntStringGreater('1', '0')).to.be.true;
    expect(bigIntStringGreater('0', '0')).to.be.false;
  });
});

describe('subtractSecondsClamped', () => {
  it('subtracts seconds from the cursor', () => {
    expect(subtractSecondsClamped('1000', 60)).to.equal('940');
  });

  it('clamps at 0 when cursor is less than seconds', () => {
    expect(subtractSecondsClamped('30', 60)).to.equal('0');
  });

  it('returns 0 when cursor equals seconds', () => {
    expect(subtractSecondsClamped('60', 60)).to.equal('0');
  });

  it('handles large timestamps beyond Number.MAX_SAFE_INTEGER', () => {
    expect(subtractSecondsClamped('100000000000000000000', 60)).to.equal(
      '99999999999999999940'
    );
  });

  it('returns 0 on malformed cursor', () => {
    expect(subtractSecondsClamped('abc', 60)).to.equal('0');
  });

  it("handles the seed cursor '0' without underflow", () => {
    expect(subtractSecondsClamped('0', 60)).to.equal('0');
  });
});
