'use strict';

// Roundtrip integration test using Node.js built-in test runner.
// Runs through real FFI calls to fon_native.dll.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { FonCollection, FonDump, nativeVersion, deserializeDumpFromFile } from '../src/index.js';

// ==================== VERSION ====================

test('nativeVersion() returns 0.3.0', () => {
    const version = nativeVersion();
    assert.equal(version, '0.3.0');
});

// ==================== COLLECTION ROUNDTRIP ====================

test('FonCollection: add and get scalar values', () => {
    const col = new FonCollection();
    col.addInt('id', 42);
    col.addString('name', 'Widget');
    col.addDouble('price', 9.99);
    col.addBool('active', true);
    col.addLong('timestamp', 1700000000n);

    assert.equal(col.getInt('id'), 42);
    assert.equal(col.getString('name'), 'Widget');
    assert.ok(Math.abs(col.getDouble('price') - 9.99) < 1e-9);
    assert.equal(col.getBool('active'), true);
    assert.equal(col.getLong('timestamp'), 1700000000n);

    col.free();
});

// ==================== DUMP ROUNDTRIP ====================

test('FonDump: build, serialize, deserialize, assert roundtrip', () => {
    // Build a collection with known values.
    const col = new FonCollection();
    col.addInt('id', 7);
    col.addString('name', 'Test Item');
    col.addDouble('price', 99.99);

    // Add to dump — ownership transfers.
    const dump = new FonDump();
    dump.add(0n, col);
    assert.equal(col.disposed, true, 'collection handle should be disposed after add');
    assert.equal(dump.size, 1);

    // Serialize to string.
    const serialized = dump.serialize();
    assert.ok(typeof serialized === 'string', 'serialized should be a string');
    assert.ok(serialized.length > 0, 'serialized should not be empty');

    // Verify the FON format contains expected tokens.
    assert.ok(serialized.includes('id=i:7'), `expected "id=i:7" in: ${serialized}`);
    assert.ok(serialized.includes('name=s:"Test Item"'), `expected name field in: ${serialized}`);

    // Deserialize back.
    const dump2 = FonDump.deserialize(serialized);
    assert.equal(dump2.size, 1);

    // Retrieve the collection at index 0 (borrowed handle).
    const col2 = dump2.get(0n);
    assert.ok(col2 !== null, 'should have a collection at index 0');

    assert.equal(col2.getInt('id'), 7);
    assert.equal(col2.getString('name'), 'Test Item');
    assert.ok(Math.abs(col2.getDouble('price') - 99.99) < 1e-6);

    // Free owned dumps (not the borrowed col2 — it is owned by dump2).
    dump.free();
    dump2.free();
});

// ==================== COLLECTION SERIALIZE / DESERIALIZE ====================

test('FonCollection.serialize / FonCollection.deserialize roundtrip', () => {
    const col = new FonCollection();
    col.addInt('count', 100);
    col.addString('label', 'hello world');
    col.addDouble('ratio', 3.14159);
    col.addBool('flag', false);

    const line = col.serialize();
    assert.ok(line.length > 0);

    const col2 = FonCollection.deserialize(line);
    assert.equal(col2.getInt('count'), 100);
    assert.equal(col2.getString('label'), 'hello world');
    assert.ok(Math.abs(col2.getDouble('ratio') - 3.14159) < 1e-9);
    assert.equal(col2.getBool('flag'), false);

    col.free();
    col2.free();
});

// ==================== OWNERSHIP / ERROR GUARD ====================

test('Using a disposed FonCollection throws', () => {
    const col = new FonCollection();
    const dump = new FonDump();
    dump.add(0n, col);
    assert.throws(() => col.addInt('x', 1), /transferred/);
    dump.free();
});

// ==================== INT ARRAY ROUNDTRIP ====================

test('FonCollection: addIntArray / getIntArray roundtrip', () => {
    const col = new FonCollection();
    const values = [1, 2, 3, -100, 2147483647];
    col.addIntArray('nums', values);

    const result = col.getIntArray('nums');
    assert.equal(result.length, values.length);
    for (let i = 0; i < values.length; i++) {
        assert.equal(result[i], values[i], `element ${i} mismatch`);
    }

    col.free();
});

// ==================== FLOAT ARRAY ROUNDTRIP ====================

test('FonCollection: addFloatArray / getFloatArray roundtrip', () => {
    const col = new FonCollection();
    const values = [1.5, -0.25, 3.14];
    col.addFloatArray('floats', values);

    const result = col.getFloatArray('floats');
    assert.equal(result.length, values.length);
    for (let i = 0; i < values.length; i++) {
        // f32 precision — tolerate small rounding error.
        assert.ok(
            Math.abs(result[i] - values[i]) < 1e-5,
            `element ${i}: expected ~${values[i]} got ${result[i]}`
        );
    }

    col.free();
});

// ==================== NESTED COLLECTION ROUNDTRIP ====================

test('FonCollection: addCollection / getCollection nested roundtrip', () => {
    const child = new FonCollection();
    child.addInt('x', 10);
    child.addString('label', 'nested');

    const parent = new FonCollection();
    parent.addCollection('child', child);

    assert.equal(child.disposed, true, 'child should be disposed after addCollection');

    const borrowed = parent.getCollection('child');
    assert.equal(borrowed.getInt('x'), 10);
    assert.equal(borrowed.getString('label'), 'nested');

    // Serialize / deserialize roundtrip to verify nesting is preserved.
    const line = parent.serialize();
    assert.ok(line.length > 0, 'serialized line should not be empty');

    const parent2 = FonCollection.deserialize(line);
    const borrowed2 = parent2.getCollection('child');
    assert.equal(borrowed2.getInt('x'), 10);
    assert.equal(borrowed2.getString('label'), 'nested');

    parent.free();
    parent2.free();
});

// ==================== COLLECTION ARRAY ROUNDTRIP ====================

test('FonCollection: addCollectionArray / getCollectionArray roundtrip', () => {
    const c1 = new FonCollection();
    c1.addInt('id', 1);
    c1.addString('name', 'Alice');

    const c2 = new FonCollection();
    c2.addInt('id', 2);
    c2.addString('name', 'Bob');

    const parent = new FonCollection();
    parent.addCollectionArray('items', [c1, c2]);

    assert.equal(c1.disposed, true, 'c1 should be disposed');
    assert.equal(c2.disposed, true, 'c2 should be disposed');

    const borrowed = parent.getCollectionArray('items');
    assert.equal(borrowed.length, 2);
    assert.equal(borrowed[0].getInt('id'), 1);
    assert.equal(borrowed[0].getString('name'), 'Alice');
    assert.equal(borrowed[1].getInt('id'), 2);
    assert.equal(borrowed[1].getString('name'), 'Bob');

    // Roundtrip through serialization.
    const line = parent.serialize();
    const parent2 = FonCollection.deserialize(line);
    const borrowed2 = parent2.getCollectionArray('items');
    assert.equal(borrowed2.length, 2);
    assert.equal(borrowed2[0].getInt('id'), 1);
    assert.equal(borrowed2[1].getString('name'), 'Bob');

    parent.free();
    parent2.free();
});

// ==================== FILE ROUNDTRIP ====================

test('FonDump: serializeToFile / deserializeDumpFromFile roundtrip', () => {
    const tmpFile = path.join(os.tmpdir(), `fon_test_${Date.now()}.fon`);
    try {
        const col = new FonCollection();
        col.addInt('id', 99);
        col.addString('tag', 'file-test');
        col.addDouble('score', 1.5);

        const dump = new FonDump();
        dump.add(0n, col);
        dump.serializeToFile(tmpFile);

        assert.ok(fs.existsSync(tmpFile), 'file should exist after serializeToFile');

        const dump2 = deserializeDumpFromFile(tmpFile);
        assert.equal(dump2.size, 1);

        const col2 = dump2.get(0n);
        assert.ok(col2 !== null, 'should have a collection at index 0');
        assert.equal(col2.getInt('id'), 99);
        assert.equal(col2.getString('tag'), 'file-test');
        assert.ok(Math.abs(col2.getDouble('score') - 1.5) < 1e-9);

        dump.free();
        dump2.free();
    } finally {
        if (fs.existsSync(tmpFile)) {
            fs.unlinkSync(tmpFile);
        }
    }
});
