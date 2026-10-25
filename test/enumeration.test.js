'use strict';

// Enumeration tests (design section 6, item 3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonCollection, FonDump } from '../src/index.js';

test('keys() returns insertion order, and kind() reports each kind', () => {
    const col = new FonCollection();
    col.addInt('b', 1);
    col.addString('a', 'text');
    col.addBoolArray('c', [true, false]);

    assert.deepStrictEqual(col.keys(), ['b', 'a', 'c']);
    assert.deepStrictEqual(col.kind('b'), { type: 'int', array: false });
    assert.deepStrictEqual(col.kind('a'), { type: 'string', array: false });
    assert.deepStrictEqual(col.kind('c'), { type: 'bool', array: true });

    const restored = FonCollection.deserialize(col.serialize());
    assert.deepStrictEqual(restored.keys(), ['b', 'a', 'c']);
    assert.deepStrictEqual(restored.kind('c'), { type: 'bool', array: true });

    col.free();
    restored.free();
});

test('dump ids() is ascending after sparse adds and removals', () => {
    const dump = new FonDump();
    for (const id of [5n, 1n, 9n, 3n, 7n]) {
        const col = new FonCollection();
        col.addLong('id', id);
        dump.add(id, col);
    }
    assert.equal(dump.remove(1n), true);
    assert.equal(dump.remove(7n), true);

    assert.deepStrictEqual(dump.ids(), [3, 5, 9]);
    assert.equal(dump.size, 3);

    dump.free();
});

test('serialize after removals renumbers records by line, ids() ascending from 0', () => {
    const dump = new FonDump();
    for (const id of [10n, 20n, 30n]) {
        const col = new FonCollection();
        col.addLong('v', id);
        dump.add(id, col);
    }
    dump.remove(20n);

    const restored = FonDump.deserialize(dump.serialize());
    assert.deepStrictEqual(restored.ids(), [0, 1]);
    assert.equal(restored.get(0n).getLong('v'), 10n);
    assert.equal(restored.get(1n).getLong('v'), 30n);

    dump.free();
    restored.free();
});

test('enumerating a 100 000-record deserialized dump finishes in well under 2 s', () => {
    const count = 100000;
    const lines = new Array(count);
    for (let i = 0; i < count; i++) {
        lines[i] = `id=i:${i}`;
    }
    const dump = FonDump.deserialize(lines.join('\n'));
    assert.equal(dump.size, count);

    const started = performance.now();
    let seen = 0;
    let last = -1;
    for (const [id, view] of dump) {
        assert.ok(id > last, 'ids must be ascending');
        last = id;
        assert.equal(view.getInt('id'), id);
        seen++;
    }
    const elapsed = performance.now() - started;

    assert.equal(seen, count);
    assert.ok(elapsed < 2000, `enumeration took ${elapsed.toFixed(0)} ms`);

    dump.free();
});

test('ids() of a 100 000-record dump returns every id in order', () => {
    const count = 100000;
    const lines = new Array(count);
    for (let i = 0; i < count; i++) {
        lines[i] = `id=i:${i}`;
    }
    const dump = FonDump.deserialize(lines.join('\n'));
    const ids = dump.ids();
    assert.equal(ids.length, count);
    assert.equal(ids[0], 0);
    assert.equal(ids[count - 1], count - 1);
    dump.free();
});
