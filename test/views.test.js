'use strict';

// View tests (design section 6, item 5): record views, nested views, stale-view detection and
// the guarantee that a view keeps its owner alive. Run with --expose-gc (see package.json).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonCollection, FonDump, FonError } from '../src/index.js';

function assertFonError(code) {
    return (error) => error instanceof FonError && error.code === code;
}

function collectGarbage() {
    if (typeof globalThis.gc !== 'function') {
        throw new Error('garbage collection is not exposed: run the tests with node --expose-gc');
    }
    globalThis.gc();
    globalThis.gc();
}

function dumpWithRecord(id, value) {
    const dump = new FonDump();
    const col = new FonCollection();
    col.addInt('w', value);
    col.addCollection('c', makeNested(value));
    dump.add(id, col);
    return dump;
}

function makeNested(value) {
    const nested = new FonCollection();
    nested.addInt('x', value);
    return nested;
}

// ==================== RECORD VIEWS ====================

test('a record view survives repeated set on itself', () => {
    const dump = dumpWithRecord(0n, 1);
    const rec = dump.get(0n);
    for (let i = 0; i < 5; i++) {
        rec.setInt('w', rec.getInt('w') * 2);
    }
    assert.equal(rec.getInt('w'), 32);
    assert.equal(dump.get(0n).getInt('w'), 32);
    dump.free();
});

test('a record view goes stale after its record is removed', () => {
    const dump = dumpWithRecord(0n, 1);
    const rec = dump.get(0n);
    dump.remove(0n);
    assert.throws(() => rec.getInt('w'), assertFonError('STALE_VIEW'));
    dump.free();
});

test('a record view goes stale after its record is replaced', () => {
    const dump = dumpWithRecord(0n, 1);
    const rec = dump.get(0n);
    const replacement = new FonCollection();
    replacement.addInt('w', 2);
    dump.set(0n, replacement);
    assert.throws(() => rec.getInt('w'), assertFonError('STALE_VIEW'));
    dump.free();
});

test('a view of another id is unaffected by changes to a different record', () => {
    const dump = new FonDump();
    for (const id of [0n, 1n, 2n]) {
        const col = new FonCollection();
        col.addInt('w', Number(id));
        dump.add(id, col);
    }
    const view0 = dump.get(0n);
    dump.remove(1n);
    dump.replace(2n, makeWithInt(20));
    assert.equal(view0.getInt('w'), 0);
    dump.free();
});

function makeWithInt(value) {
    const col = new FonCollection();
    col.addInt('w', value);
    return col;
}

// ==================== NESTED VIEWS ====================

test('a nested view goes stale after a field change in its record (dangling child)', () => {
    const dump = dumpWithRecord(0n, 5);
    const rec = dump.get(0n);
    const nested = rec.getCollection('c');
    assert.equal(nested.getInt('x'), 5);

    rec.setInt('c', 7);

    assert.throws(() => nested.getInt('x'), assertFonError('STALE_VIEW'));
    dump.free();
});

test('mutating through a nested view keeps that view valid and makes its siblings stale', () => {
    const root = new FonCollection();
    root.addCollection('a', makeNested(1));
    root.addCollection('b', makeNested(2));

    const first = root.getCollection('a');
    const sibling = root.getCollection('b');

    first.addInt('added', 3);
    assert.equal(first.getInt('added'), 3);
    assert.throws(() => sibling.getInt('x'), assertFonError('STALE_VIEW'));
    root.free();
});

test('a nested view of an owned collection goes stale after the owner is mutated', () => {
    const root = new FonCollection();
    root.addCollection('a', makeNested(1));
    const nested = root.getCollection('a');
    root.addInt('unrelated', 1);
    assert.throws(() => nested.getInt('x'), assertFonError('STALE_VIEW'));
    root.free();
});

test('a nested view of a dump record is stale after a sibling nested view is mutated', () => {
    const dump = dumpWithRecord(0n, 1);
    const rec = dump.get(0n);
    const first = rec.getCollection('c');
    const second = rec.getCollection('c');
    first.setInt('x', 9);
    assert.equal(first.getInt('x'), 9);
    assert.throws(() => second.getInt('x'), assertFonError('STALE_VIEW'));
    dump.free();
});

// ==================== OWNER DISPOSAL ====================

test('any view after its dump is freed throws a disposed error', () => {
    const dump = dumpWithRecord(0n, 1);
    const rec = dump.get(0n);
    const nested = rec.getCollection('c');
    dump.free();
    assert.throws(() => rec.getInt('w'), /freed or transferred/);
    assert.throws(() => nested.getInt('x'), /freed or transferred/);
});

test('any view after its owned root is freed throws a disposed error', () => {
    const root = new FonCollection();
    root.addCollection('a', makeNested(4));
    const nested = root.getCollection('a');
    root.free();
    assert.throws(() => nested.getInt('x'), /freed or transferred/);
});

// ==================== A VIEW KEEPS ITS OWNER ALIVE ====================

function recordViewOnly() {
    const dump = new FonDump();
    const col = new FonCollection();
    col.addInt('w', 11);
    col.addString('name', 'kept alive');
    dump.add(0n, col);
    return dump.get(0n);
}

function nestedViewOnly() {
    const root = new FonCollection();
    root.addCollection('c', makeNested(12));
    return root.getCollection('c');
}

test('a record view keeps its dump alive after every reference to the dump is gone', () => {
    const view = recordViewOnly();
    collectGarbage();
    assert.equal(view.getInt('w'), 11);
    assert.equal(view.getString('name'), 'kept alive');
});

test('a nested view keeps its owned root alive after every reference to the root is gone', () => {
    const view = nestedViewOnly();
    collectGarbage();
    assert.equal(view.getInt('x'), 12);
});

// ==================== ABSENT-ID REMOVE ON A DESERIALIZED DUMP ====================

function deserializedDump() {
    return FonDump.deserialize('x=i:0,name=s:"record-0"\nx=i:1,name=s:"record-1"\nx=i:2,name=s:"record-2"');
}

test('a record view of a deserialized dump stays readable after remove of an absent id', () => {
    const dump = deserializedDump();
    const rec = dump.get(0n);
    assert.equal(dump.remove(99n), false);
    assert.equal(rec.getInt('x'), 0);
    assert.equal(rec.getString('name'), 'record-0');
    rec.setInt('x', 5);
    assert.equal(dump.get(0n).getInt('x'), 5);
    dump.free();
});

test('a record view of a deserialized dump stays readable after removeMany of absent ids', () => {
    const dump = deserializedDump();
    const rec = dump.get(0n);
    assert.equal(dump.removeMany([99n, 100n]), 0);
    assert.equal(rec.getInt('x'), 0);
    assert.equal(rec.getString('name'), 'record-0');
    dump.free();
});
