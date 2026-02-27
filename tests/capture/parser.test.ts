import { stripAnsi, cleanCapture, splitForDiscord, stripOuterCodeblock, stripFilePaths } from '../../src/capture/parser.js';

function createDeterministicPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInt(next: () => number, min: number, max: number): number {
  return Math.floor(next() * (max - min + 1)) + min;
}

function generateSyntheticOutput(seed: number): string {
  const next = createDeterministicPrng(seed);
  const targetLength = randomInt(next, 0, 16000);
  if (targetLength === 0) return '';

  let out = '';
  while (out.length < targetLength) {
    const mode = randomInt(next, 0, 4);
    if (mode === 0) {
      out += `line-${randomInt(next, 1, 99999)} `;
      out += 'alpha '.repeat(randomInt(next, 1, 8));
      out += '\n';
      continue;
    }
    if (mode === 1) {
      out += 'x'.repeat(randomInt(next, 1, 2600));
      out += randomInt(next, 0, 1) === 0 ? '' : '\n';
      continue;
    }
    if (mode === 2) {
      out += '0123456789-'.repeat(randomInt(next, 1, 70));
      out += '\n';
      continue;
    }
    if (mode === 3) {
      out += 'word '.repeat(randomInt(next, 1, 120));
      out += '\n\n';
      continue;
    }
    out += 'A_B-C.D '.repeat(randomInt(next, 1, 90));
  }

  return out.slice(0, targetLength);
}

describe('stripAnsi', () => {
  it('returns plain text unchanged', () => {
    const plain = 'hello world';
    expect(stripAnsi(plain)).toBe(plain);
  });

  it('strips color codes', () => {
    const input = '\x1B[31mred\x1B[0m normal';
    expect(stripAnsi(input)).toBe('red normal');
  });

  it('strips bold and underline codes', () => {
    const input = '\x1B[1mbold\x1B[0m \x1B[4munderline\x1B[0m';
    expect(stripAnsi(input)).toBe('bold underline');
  });

  it('strips cursor movement codes', () => {
    const input = '\x1B[2Jclear\x1B[H move';
    expect(stripAnsi(input)).toBe('clear move');
  });

  it('strips OSC sequences with BEL terminator', () => {
    const input = '\x1B]0;window title\x07content';
    expect(stripAnsi(input)).toBe('content');
  });

  it('strips OSC sequences with ST terminator', () => {
    const input = '\x1B]0;title\x1B\\content';
    expect(stripAnsi(input)).toBe('content');
  });

  it('strips charset sequences', () => {
    // Regex only matches \x1B([A-Z]), so \x1B(B is stripped but \x1B(0 is not
    expect(stripAnsi('\x1B(Btext')).toBe('text');
    expect(stripAnsi('\x1B(Atext\x1B(Bmore')).toBe('textmore');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('handles multiple mixed ANSI codes in one string', () => {
    const input = '\x1B[31m\x1B[1mred bold\x1B[0m \x1B]0;title\x07\x1B[4munderline\x1B[0m';
    expect(stripAnsi(input)).toBe('red bold underline');
  });
});

describe('cleanCapture', () => {
  it('strips ANSI and removes trailing blank lines', () => {
    const input = '\x1B[32mgreen\x1B[0m\ntext\n\n\n';
    expect(cleanCapture(input)).toBe('green\ntext');
  });

  it('preserves internal blank lines', () => {
    const input = 'line1\n\nline3\n\n';
    expect(cleanCapture(input)).toBe('line1\n\nline3');
  });

  it('returns empty string for all-blank input', () => {
    expect(cleanCapture('\n\n\n')).toBe('');
  });

  it('handles content with no trailing blanks', () => {
    const input = 'line1\nline2';
    expect(cleanCapture(input)).toBe('line1\nline2');
  });

  it('handles mixed ANSI and trailing blanks', () => {
    const input = '\x1B[1mbold\x1B[0m\n\x1B[31mred\x1B[0m\n\n';
    expect(cleanCapture(input)).toBe('bold\nred');
  });

  it('normalizes CRLF/CR line endings and strips NUL bytes', () => {
    const input = 'line1\r\nline2\rline3\u0000\r\n\r\n';
    expect(cleanCapture(input)).toBe('line1\nline2\nline3');
  });
});

describe('splitForDiscord', () => {
  it('returns single-element array for short text', () => {
    const short = 'hello world';
    const result = splitForDiscord(short);
    expect(result).toEqual([short]);
  });

  it('splits long text at line boundaries', () => {
    const lines = Array(100).fill('line').join('\n');
    const result = splitForDiscord(lines, 200);
    expect(result.length).toBeGreaterThan(1);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(200);
    });
  });

  it('respects custom maxLen parameter', () => {
    const text = 'a'.repeat(500);
    const result = splitForDiscord(text, 100);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(100);
    });
  });

  it('splits single long line exceeding maxLen without truncation', () => {
    const longLine = 'x'.repeat(2500);
    const result = splitForDiscord(longLine, 1900);
    expect(result.length).toBeGreaterThan(0);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(1900);
    });
    expect(result.join('')).toBe(longLine);
  });

  it('handles empty string', () => {
    const result = splitForDiscord('');
    expect(result).toEqual(['']);
  });

  it('each chunk is under maxLen with default value', () => {
    const longText = Array(200).fill('some longer line content').join('\n');
    const result = splitForDiscord(longText);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(1900);
    });
  });

  it('enforces Discord hard cap (2000) even if caller passes larger maxLen', () => {
    const text = 'z'.repeat(4100);
    const result = splitForDiscord(text, 5000);
    expect(result.length).toBeGreaterThan(1);
    result.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    });
    expect(result.join('')).toBe(text);
  });

  it('preserves line structure when possible', () => {
    const text = 'line1\nline2\nline3';
    const result = splitForDiscord(text, 100);
    result.forEach(chunk => {
      expect(chunk.split('\n').every(line => line.length <= 100)).toBe(true);
    });
  });

  it('strips outer codeblock before splitting', () => {
    const text = '```\nhello world\n```';
    const result = splitForDiscord(text);
    expect(result).toEqual(['hello world']);
  });

  it('strips outer codeblock with language tag before splitting', () => {
    const text = '```typescript\nconst x = 1;\n```';
    const result = splitForDiscord(text);
    expect(result).toEqual(['const x = 1;']);
  });

  it('preserves nested codeblocks after stripping outer', () => {
    const text = '```\nsome text\n```js\ncode\n```\nmore text\n```';
    const result = splitForDiscord(text);
    expect(result[0]).toContain('```js');
  });

  it('closes unclosed codeblock at chunk boundary and re-opens in next chunk', () => {
    // Build text with explanation + a codeblock that will span chunks
    // (pure codeblock would be stripped by stripOuterCodeblock, so add prefix text)
    const yamlLines = Array(50).fill('  key: value  # some yaml config line').join('\n');
    const text = 'Here is the manifest:\n\n```yaml\n' + yamlLines + '\n```';
    const result = splitForDiscord(text, 500);

    expect(result.length).toBeGreaterThan(1);

    // Each chunk should have balanced codeblock fences
    for (const chunk of result) {
      const fences = chunk.match(/^```/gm) || [];
      expect(fences.length % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it('does not alter chunks that have no codeblocks', () => {
    const text = Array(100).fill('plain text line here').join('\n');
    const result = splitForDiscord(text, 500);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk).not.toContain('```');
    }
  });

  it('handles mixed text and codeblock split across chunks', () => {
    const code = Array(40).fill('  command: echo hello').join('\n');
    const text = 'Here is the manifest:\n\n```yaml\n' + code + '\n```\n\nDone!';
    const result = splitForDiscord(text, 500);

    expect(result.length).toBeGreaterThan(1);

    // Every chunk should have balanced fences
    for (const chunk of result) {
      const fences = chunk.match(/^```/gm) || [];
      expect(fences.length % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it('stress: 50 synthetic outputs keep full text without truncation', () => {
    const cases = 50;
    for (let i = 0; i < cases; i += 1) {
      const seed = 1000 + i;
      const text = generateSyntheticOutput(seed);
      const localNext = createDeterministicPrng(seed * 7);
      const requestedMax = randomInt(localNext, 60, 2600);
      const effectiveMax = Math.min(2000, requestedMax);

      const chunks = splitForDiscord(text, requestedMax);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(effectiveMax);
      }
      if (text.length > 0) {
        expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
      }
      expect(chunks.join('')).toBe(text);
    }
  });
});

describe('stripOuterCodeblock', () => {
  it('returns plain text unchanged', () => {
    expect(stripOuterCodeblock('hello world')).toBe('hello world');
  });

  it('strips simple codeblock fence', () => {
    expect(stripOuterCodeblock('```\nfoo bar\n```')).toBe('foo bar');
  });

  it('strips codeblock with language tag', () => {
    expect(stripOuterCodeblock('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('strips codeblock with python language tag', () => {
    expect(stripOuterCodeblock('```python\nprint("hi")\n```')).toBe('print("hi")');
  });

  it('preserves text that is not fully wrapped', () => {
    const text = '```\ncode\n```\nextra text';
    expect(stripOuterCodeblock(text)).toBe(text);
  });

  it('preserves text with only opening fence', () => {
    expect(stripOuterCodeblock('```\nno closing')).toBe('```\nno closing');
  });

  it('preserves text with only closing fence', () => {
    expect(stripOuterCodeblock('no opening\n```')).toBe('no opening\n```');
  });

  it('handles multiline content', () => {
    const text = '```\nline1\nline2\nline3\n```';
    expect(stripOuterCodeblock(text)).toBe('line1\nline2\nline3');
  });

  it('preserves nested codeblocks (even count)', () => {
    const text = '```\nouter\n```js\ninner\n```\nouter2\n```';
    expect(stripOuterCodeblock(text)).toBe('outer\n```js\ninner\n```\nouter2');
  });

  it('does not strip when inner fences are odd (not fully wrapped)', () => {
    const text = '```\npart1\n```\npart2';
    expect(stripOuterCodeblock(text)).toBe(text);
  });

  it('handles empty codeblock', () => {
    expect(stripOuterCodeblock('```\n```')).toBe('');
  });

  it('handles whitespace around the text', () => {
    expect(stripOuterCodeblock('  ```\nfoo\n```  ')).toBe('foo');
  });

  it('returns empty string unchanged', () => {
    expect(stripOuterCodeblock('')).toBe('');
  });

  it('handles single backtick lines (not codeblock)', () => {
    expect(stripOuterCodeblock('`inline code`')).toBe('`inline code`');
  });
});

describe('stripFilePaths', () => {
  it('returns text unchanged when no file paths given', () => {
    const text = 'Hello world';
    expect(stripFilePaths(text, [])).toBe(text);
  });

  it('removes a standalone absolute path', () => {
    const text = 'Here is the file: /home/user/project/.mudcode/files/chart.png done';
    const result = stripFilePaths(text, ['/home/user/project/.mudcode/files/chart.png']);
    expect(result).toBe('Here is the file:  done');
    expect(result).not.toContain('/home/user');
  });

  it('removes a backtick-wrapped path', () => {
    const text = 'Generated: `/tmp/output.png`';
    const result = stripFilePaths(text, ['/tmp/output.png']);
    expect(result).toBe('Generated: ');
  });

  it('removes a markdown image with the path', () => {
    const text = 'See below:\n![chart](/tmp/chart.png)\nDone';
    const result = stripFilePaths(text, ['/tmp/chart.png']);
    expect(result).toBe('See below:\n\nDone');
  });

  it('removes multiple paths from text', () => {
    const text = 'Files: `/tmp/a.png` and `/tmp/b.pdf`';
    const result = stripFilePaths(text, ['/tmp/a.png', '/tmp/b.pdf']);
    expect(result).toBe('Files:  and ');
  });

  it('collapses 3+ consecutive newlines into 2', () => {
    const text = 'Hello\n\n\n\nWorld';
    const result = stripFilePaths(text, []);
    expect(result).toBe('Hello\n\nWorld');
  });

  it('collapses newlines left by path removal', () => {
    const text = 'Before\n\n/tmp/file.png\n\nAfter';
    const result = stripFilePaths(text, ['/tmp/file.png']);
    expect(result).toBe('Before\n\nAfter');
  });

  it('handles path with regex special characters', () => {
    const text = 'File: /tmp/output[1].png done';
    const result = stripFilePaths(text, ['/tmp/output[1].png']);
    expect(result).toBe('File:  done');
  });

  it('removes all occurrences of the same path', () => {
    const text = 'See /tmp/f.png and also /tmp/f.png';
    const result = stripFilePaths(text, ['/tmp/f.png']);
    expect(result).toBe('See  and also ');
  });
});
