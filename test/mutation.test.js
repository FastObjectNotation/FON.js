'use strict';

// Mutation tests (design section 6, item 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonCollection, FonDump, FonError } from '../src/index.js';

function assertFonError(code) {
    return (error) => error instanceof FonError && error.code === code;
}

function buildDump(count) {
    const dump = new FonDump();
    for (let i = 0; i < count; i++) {
        const col = new FonCollection();
        col.addInt('n', i);
        dump.add(BigInt(i), col);
    }
    return dump;
}

test('add on an existing key throws ALREADY_EXISTS', () => {
    const col = new FonCollection();
    col.addInt('k', 1);
    assert.throws(() => col.addInt('k', 2), assertFonError('ALREADY_EXISTS'));
    assert.equal(col.getInt('k'), 1);
    col.free();
});

test('set is an upsert: replaces an existing field and creates a missing one', () => {
    const col = new FonCollection();
    col.setInt('k', 1);
    col.setInt('k', 2);
    assert.equal(col.getInt('k'), 2);

    col.setString('k', 'now a string');
    assert.equal(col.getString('k'), 'now a string');
    assert.deepStrictEqual(col.kind('k'), { type: 'string', array: false });
    col.free();
});

test('dump add on an existing id throws ALREADY_EXISTS', () => {
    const dump = buildDump(2);
    const col = new FonCollection();
    col.addInt('n', 99);
    assert.throws(() => dump.add(0n, col), assertFonError('ALREADY_EXISTS'));
    assert.equal(col.disposed, false);
    assert.equal(dump.get(0n).getInt('n'), 0);
    col.free();
    dump.free();
});

test('dump replace of an absent id throws NOT_FOUND; set creates it', () => {
    const dump = new FonDump();
    const col = new FonCollection();
    col.addInt('n', 1);
    assert.throws(() => dump.replace(42n, col), assertFonError('NOT_FOUND'));
    assert.equal(col.disposed, false);

    const created = new FonCollection();
    created.addInt('n', 2);
    dump.set(42n, created);
    assert.equal(dump.get(42n).getInt('n'), 2);

    col.free();
    dump.free();
});

test('dump replace of a live id swaps the record', () => {
    const dump = buildDump(2);
    const replacement = new FonCollection();
    replacement.addInt('n', 500);
    dump.replace(1n, replacement);
    assert.equal(dump.get(1n).getInt('n'), 500);
    assert.equal(dump.size, 2);
    dump.free();
});

test('remove returns true for a present key and false for an absent one', () => {
    const col = new FonCollection();
    col.addInt('k', 1);
    assert.equal(col.remove('k'), true);
    assert.equal(col.has('k'), false);
    assert.equal(col.remove('k'), false);
    col.free();
});

test('dump remove returns true or false', () => {
    const dump = buildDump(2);
    assert.equal(dump.remove(0n), true);
    assert.equal(dump.remove(0n), false);
    assert.equal(dump.size, 1);
    dump.free();
});

test('removeMany returns the count, ignoring absent and duplicate ids', () => {
    const dump = buildDump(5);
    const removed = dump.removeMany([1n, 1n, 99n, 2n, 1000n]);
    assert.equal(removed, 2);
    assert.deepStrictEqual(dump.ids(), [0, 3, 4]);
    dump.free();
});

test('other ids are unchanged after a remove', () => {
    const dump = buildDump(4);
    dump.remove(1n);
    assert.deepStrictEqual(dump.ids(), [0, 2, 3]);
    assert.equal(dump.get(0n).getInt('n'), 0);
    assert.equal(dump.get(2n).getInt('n'), 2);
    assert.equal(dump.get(3n).getInt('n'), 3);
    assert.equal(dump.get(1n), null);
    dump.free();
});

test('serialize after remove renumbers the lines', () => {
    const dump = buildDump(4);
    dump.remove(1n);
    const restored = FonDump.deserialize(dump.serialize());
    assert.deepStrictEqual(restored.ids(), [0, 1, 2]);
    assert.equal(restored.get(0n).getInt('n'), 0);
    assert.equal(restored.get(1n).getInt('n'), 2);
    assert.equal(restored.get(2n).getInt('n'), 3);
    dump.free();
    restored.free();
});
