'use strict';

// Ownership transfer tests (design section 6, item 6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonCollection, FonDump, FonError } from '../src/index.js';

function assertFonError(code) {
    return (error) => error instanceof FonError && error.code === code;
}

function makeChild(value) {
    const child = new FonCollection();
    child.addInt('x', value);
    return child;
}

test('putting a view into another container throws INVALID_ARGUMENT; clone() then put works', () => {
    const root = new FonCollection();
    root.addCollection('c', makeChild(1));
    const view = root.getCollection('c');

    const other = new FonCollection();
    assert.throws(() => other.addCollection('v', view), assertFonError('INVALID_ARGUMENT'));
    assert.throws(() => other.addCollectionArray('vs', [view]), assertFonError('INVALID_ARGUMENT'));

    const dump = new FonDump();
    assert.throws(() => dump.add(0n, view), assertFonError('INVALID_ARGUMENT'));

    other.addCollection('v', view.clone());
    assert.equal(other.getCollection('v').getInt('x'), 1);

    dump.free();
    other.free();
    root.free();
});

test('after a successful put the passed wrapper is unusable', () => {
    const parent = new FonCollection();
    const child = makeChild(2);
    parent.addCollection('c', child);
    assert.equal(child.disposed, true);
    assert.throws(() => child.addInt('y', 1), /transferred/);
    assert.throws(() => child.getInt('x'), /transferred/);
    parent.free();
});

test('after a successful dump add the passed wrapper is unusable', () => {
    const dump = new FonDump();
    const child = makeChild(3);
    dump.add(0n, child);
    assert.equal(child.disposed, true);
    assert.throws(() => child.getInt('x'), /transferred/);
    dump.free();
});

test('a failed put (ADD on an existing key) leaves the child usable and owned', () => {
    const parent = new FonCollection();
    parent.addInt('k', 1);
    const child = makeChild(4);
    assert.throws(() => parent.addCollection('k', child), assertFonError('ALREADY_EXISTS'));
    assert.equal(child.disposed, false);
    child.addInt('y', 2);
    assert.equal(child.getInt('y'), 2);
    assert.equal(child.getInt('x'), 4);
    child.free();
    parent.free();
});

test('a failed dump add on an existing id leaves the child usable and owned', () => {
    const dump = new FonDump();
    const first = makeChild(5);
    dump.add(0n, first);
    const second = makeChild(6);
    assert.throws(() => dump.add(0n, second), assertFonError('ALREADY_EXISTS'));
    assert.equal(second.disposed, false);
    assert.equal(second.getInt('x'), 6);
    second.free();
    dump.free();
});

test('inserting a root into its own nested view throws INVALID_ARGUMENT', () => {
    const root = new FonCollection();
    root.addCollection('n', new FonCollection());
    const nested = root.getCollection('n');

    assert.throws(() => nested.addCollection('back', root), assertFonError('INVALID_ARGUMENT'));
    assert.throws(() => root.addCollection('self', root), assertFonError('INVALID_ARGUMENT'));

    assert.equal(root.disposed, false);
    assert.equal(root.getCollection('n').size, 0);
    root.free();
});

test('the same child twice in one array throws INVALID_ARGUMENT and leaves it usable', () => {
    const parent = new FonCollection();
    const child = makeChild(7);
    assert.throws(() => parent.addCollectionArray('items', [child, child]), assertFonError('INVALID_ARGUMENT'));
    assert.equal(child.disposed, false);
    assert.equal(child.getInt('x'), 7);
    assert.equal(parent.has('items'), false);
    child.free();
    parent.free();
});

test('a key with = " { } [ ] CR or LF throws INVALID_ARGUMENT; the rejected child stays owned and usable', () => {
    const reservedKeys = ['a=b', 'q"q', 'open{', 'close}', 'open[', 'close]', 'cr\rkey', 'lf\nkey'];
    const parent = new FonCollection();
    for (const key of reservedKeys) {
        const child = makeChild(9);
        assert.throws(() => parent.addCollection(key, child), assertFonError('INVALID_ARGUMENT'));
        assert.throws(() => parent.setCollection(key, child), assertFonError('INVALID_ARGUMENT'));
        assert.throws(() => parent.addCollectionArray(key, [child]), assertFonError('INVALID_ARGUMENT'));
        assert.equal(child.disposed, false);
        assert.equal(child.getInt('x'), 9);
        child.free();
        assert.throws(() => parent.addInt(key, 1), assertFonError('INVALID_ARGUMENT'));
        assert.equal(parent.has(key), false);
    }
    assert.deepStrictEqual(parent.keys(), []);
    parent.free();
});
