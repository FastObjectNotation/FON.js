'use strict';

// Roundtrip integration test using Node.js built-in test runner.
// Runs through real FFI calls to fon_native.dll.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonCollection, FonDump, nativeVersion } from '../src/index.js';

// ==================== VERSION ====================

test('nativeVersion() returns 0.2.1', () => {
    const version = nativeVersion();
    assert.equal(version, '0.2.1');
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
