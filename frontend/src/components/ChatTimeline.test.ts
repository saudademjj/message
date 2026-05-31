import { describe, expect, it } from 'vitest';
import { collectExpectedReadUserIDs, countExpectedReadUsers, isExpectedReadUser } from '../readState';

describe('countExpectedReadUsers', () => {
  it('counts peer users once even when they have multiple encrypted devices', () => {
    expect(countExpectedReadUsers({
      '1:desktop': {},
      '1:mobile': {},
      '2:phone': {},
      '2:laptop': {},
    }, 1)).toBe(1);
  });

  it('ignores malformed recipient addresses', () => {
    expect(countExpectedReadUsers({
      invalid: {},
      '3:desktop': {},
    }, 1)).toBe(1);
  });

  it('returns the unique peer ids that can legitimately read the message', () => {
    expect(collectExpectedReadUserIDs({
      '1:desktop': {},
      '2:phone': {},
      '2:laptop': {},
      '3:tablet': {},
    }, 1)).toEqual([2, 3]);
  });

  it('only treats encrypted peer recipients as expected readers', () => {
    const wrappedKeys = {
      '1:desktop': {},
      '2:phone': {},
    };

    expect(isExpectedReadUser(wrappedKeys, 1, 2)).toBe(true);
    expect(isExpectedReadUser(wrappedKeys, 1, 3)).toBe(false);
    expect(isExpectedReadUser(wrappedKeys, 1, 1)).toBe(false);
  });
});
