'use strict';

// String handling tests (design section 6, item 2: FON.net issue #1 and related defects).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonCollection, FonDump } from '../src/index.js';

function roundtripValue(value) {
    const col = new FonCollection();
    col.addString('v', value);
    const direct = col.getString('v');
    const restored = FonCollection.deserialize(col.serialize());
    const viaLine = restored.getString('v');
    col.free();
    restored.free();
    return { direct, viaLine };
}

function assertStringRoundtrip(value) {
    const result = roundtripValue(value);
    assert.equal(result.direct, value);
    assert.equal(result.viaLine, value);
}

// ==================== LENGTH BOUNDARIES ====================

test('scalar strings of 8191, 8192 and 100000 bytes are intact', () => {
    for (const length of [8191, 8192, 100000]) {
        const value = 'x'.repeat(length);
        assertStringRoundtrip(value);
    }
});

test('a middle item of a string array of 8191, 8192 and 100000 bytes is intact', () => {
    for (const length of [8191, 8192, 100000]) {
        const middle = 'b'.repeat(length);
        const items = ['x', middle, 'y'];
        const col = new FonCollection();
        col.addStringArray('items', items);
        assert.deepStrictEqual(col.getStringArray('items'), items);

        const restored = FonCollection.deserialize(col.serialize());
        assert.deepStrictEqual(restored.getStringArray('items'), items);

        col.free();
        restored.free();
    }
});

// ==================== MULTI-BYTE TEXT ====================

test('5000 Cyrillic "ж" (2 bytes each) is intact with no U+FFFD', () => {
    const value = 'ж'.repeat(5000);
    const result = roundtripValue(value);
    assert.ok(!result.direct.includes('\uFFFD'));
    assert.ok(!result.viaLine.includes('\uFFFD'));
    assert.equal(result.direct, value);
    assert.equal(result.viaLine, value);
});

test('2500 emoji "😀" (4 bytes each) is intact with no U+FFFD', () => {
    const value = '😀'.repeat(2500);
    const result = roundtripValue(value);
    assert.ok(!result.direct.includes('\uFFFD'));
    assert.ok(!result.viaLine.includes('\uFFFD'));
    assert.equal(result.direct, value);
    assert.equal(result.viaLine, value);
});

// ==================== EMBEDDED NUL ====================

test('embedded U+0000 in a value is kept', () => {
    assertStringRoundtrip('a\u0000b');
});

test('embedded U+0000 in a key is kept (enumerated and read back)', () => {
    const key = 'k\u0000ey';
    const col = new FonCollection();
    col.addString(key, 'v');
    assert.deepStrictEqual(col.keys(), [key]);
    assert.equal(col.getString(key), 'v');

    const restored = FonCollection.deserialize(col.serialize());
    assert.deepStrictEqual(restored.keys(), [key]);
    assert.equal(restored.getString(key), 'v');

    col.free();
    restored.free();
});

// ==================== LONG KEYS ====================

test('a key longer than 512 bytes is enumerated and read back', () => {
    const key = 'k'.repeat(600);
    const col = new FonCollection();
    col.addInt(key, 1);
    assert.deepStrictEqual(col.keys(), [key]);
    assert.equal(col.getInt(key), 1);

    const restored = FonCollection.deserialize(col.serialize());
    assert.deepStrictEqual(restored.keys(), [key]);
    assert.equal(restored.getInt(key), 1);

    col.free();
    restored.free();
});

// ==================== ESCAPES AND CONTROL CHARACTERS ====================

test('a value ending with a backslash is intact', () => {
    assertStringRoundtrip('C:\\dir\\');
    assertStringRoundtrip('\\');
    assertStringRoundtrip('end with two \\\\');
});

test('a string array item ending with a backslash is intact', () => {
    const items = ['C:\\dir\\', 'plain', 'x\\'];
    const col = new FonCollection();
    col.addStringArray('items', items);
    const restored = FonCollection.deserialize(col.serialize());
    assert.deepStrictEqual(restored.getStringArray('items'), items);
    col.free();
    restored.free();
});

test('control characters \\x01 and \\x1b are intact', () => {
    assertStringRoundtrip('a\x01b');
    assertStringRoundtrip('\x1b[31mred\x1b[0m');
});

test('quotes, commas, brackets and braces inside strings are intact', () => {
    assertStringRoundtrip('a,b"c]d}e{f=g:h');
    assertStringRoundtrip('"quoted", [bracketed], {braced}');
});

test('quotes, commas, brackets and braces inside nested objects are intact', () => {
    const tricky = 'x"y,z]w}v{u=t:s\\';
    const child = new FonCollection();
    child.addString('text', tricky);
    child.addStringArray('texts', [tricky, '"', ',']);

    const parent = new FonCollection();
    parent.addCollection('child', child);
    parent.addCollectionArray('children', [makeChild(tricky), makeChild('"}]')]);

    const restored = FonCollection.deserialize(parent.serialize());
    const nested = restored.getCollection('child');
    assert.equal(nested.getString('text'), tricky);
    assert.deepStrictEqual(nested.getStringArray('texts'), [tricky, '"', ',']);
    const items = restored.getCollectionArray('children');
    assert.equal(items[0].getString('text'), tricky);
    assert.equal(items[1].getString('text'), '"}]');

    parent.free();
    restored.free();
});

function makeChild(text) {
    const child = new FonCollection();
    child.addString('text', text);
    return child;
}

test('dump records keep tricky strings through serialize/deserialize', () => {
    const tricky = 'C:\\path\\, "quoted" {x} [y]\x01';
    const dump = new FonDump();
    const col = new FonCollection();
    col.addString('s', tricky);
    dump.add(0n, col);
    const restored = FonDump.deserialize(dump.serialize());
    assert.equal(restored.get(0n).getString('s'), tricky);
    dump.free();
    restored.free();
});
