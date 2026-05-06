import { parseFrontmatter } from '../lib/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses key-value pairs between --- delimiters', () => {
    const result = parseFrontmatter('---\nassignment: agent-efficiency\nepochs: 5\n---\n# Goal');
    expect(result).toEqual({ assignment: 'agent-efficiency', epochs: '5' });
  });

  it('returns empty object when no frontmatter found', () => {
    expect(parseFrontmatter('# Goal')).toEqual({});
  });

  it('parses frontmatter with no trailing content', () => {
    expect(parseFrontmatter('---\nfoo: bar\n---')).toEqual({ foo: 'bar' });
  });

  it('returns empty object for frontmatter with only delimiters', () => {
    expect(parseFrontmatter('---\n---')).toEqual({});
  });

  it('handles values that contain colons', () => {
    const result = parseFrontmatter('---\nurl: http://example.com\n---');
    expect(result).toEqual({ url: 'http://example.com' });
  });

  it('trims leading and trailing whitespace from keys and values', () => {
    const result = parseFrontmatter('---\n  key  :  value  \n---');
    expect(result).toEqual({ key: 'value' });
  });

  it('silently ignores lines without a colon', () => {
    const result = parseFrontmatter('---\nfoo: bar\nmalformed\nbaz: qux\n---');
    expect(result).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('silently ignores blank lines', () => {
    const result = parseFrontmatter('---\nfoo: bar\n\nbaz: qux\n---');
    expect(result).toEqual({ foo: 'bar', baz: 'qux' });
  });
});
