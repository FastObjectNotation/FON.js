'use strict';

// Roundtrip tests through the native fon_native library (design section 6, items 1 and existing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { FonCollection, FonDump, nativeVersion, deserializeDumpFromFile } from '../src/index.js';

// ==================== VERSION ====================

test('nativeVersion() returns 0.4.0', () => {
    const version = nativeVersion();
    assert.equal(version, '0.4.0');
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

// ==================== ALL 23 VALUE KINDS (design 6.1) ====================

function fillAllKinds(col) {
    col.addByte('byteMin', 0)
        .addByte('byteMax', 255)
        .addShort('shortMin', -32768)
        .addShort('shortMax', 32767)
        .addInt('intMin', -2147483648)
        .addInt('intMax', 2147483647)
        .addUInt('uintMin', 0)
        .addUInt('uintMax', 4294967295)
        .addLong('longMin', -(2n ** 63n))
        .addLong('longMax', 2n ** 63n - 1n)
        .addULong('ulongMin', 0n)
        .addULong('ulongMax', 2n ** 64n - 1n)
        .addFloat('floatSpecial', NaN)
        .addFloat('floatInf', Infinity)
        .addFloat('floatNegInf', -Infinity)
        .addDouble('doubleSpecial', -Infinity)
        .addDouble('doubleNaN', NaN)
        .addDouble('doubleInf', Infinity)
        .addDouble('doublePi', Math.PI)
        .addBool('bool', false)
        .addString('string', 'hello')
        .addRaw('raw', Buffer.from([0, 1, 127, 128, 255]))
        .addByteArray('byteArray', [0, 128, 255])
        .addShortArray('shortArray', [-32768, 0, 32767])
        .addIntArray('intArray', [-2147483648, 2147483647])
        .addUIntArray('uintArray', [0, 4294967295])
        .addLongArray('longArray', [-(2n ** 63n), 2n ** 63n - 1n])
        .addULongArray('ulongArray', [0n, 2n ** 64n - 1n])
        .addFloatArray('floatArray', [NaN, Infinity, -Infinity, 1.5, -0.25])
        .addDoubleArray('doubleArray', [-Infinity, NaN, Infinity, Math.PI])
        .addBoolArray('boolArray', [true, false, true])
        .addStringArray('stringArray', ['a', '', 'c'])
        .addCollection('nested', makeNestedChild())
        .addCollectionArray('nestedArray', [makeNestedChild(1), makeNestedChild(2)]);
}

function makeNestedChild(seed = 0) {
    const child = new FonCollection();
    child.addInt('seed', seed);
    child.addString('label', `child-${seed}`);
    return child;
}

function assertAllKinds(col) {
    assert.equal(col.getByte('byteMin'), 0);
    assert.equal(col.getByte('byteMax'), 255);
    assert.equal(col.getShort('shortMin'), -32768);
    assert.equal(col.getShort('shortMax'), 32767);
    assert.equal(col.getInt('intMin'), -2147483648);
    assert.equal(col.getInt('intMax'), 2147483647);
    assert.equal(col.getUInt('uintMin'), 0);
    assert.equal(col.getUInt('uintMax'), 4294967295);
    assert.equal(col.getLong('longMin'), -(2n ** 63n));
    assert.equal(col.getLong('longMax'), 2n ** 63n - 1n);
    assert.equal(col.getULong('ulongMin'), 0n);
    assert.equal(col.getULong('ulongMax'), 2n ** 64n - 1n);
    assert.ok(Number.isNaN(col.getFloat('floatSpecial')));
    assert.equal(col.getFloat('floatInf'), Infinity);
    assert.equal(col.getFloat('floatNegInf'), -Infinity);
    assert.equal(col.getDouble('doubleSpecial'), -Infinity);
    assert.ok(Number.isNaN(col.getDouble('doubleNaN')));
    assert.equal(col.getDouble('doubleInf'), Infinity);
    assert.equal(col.getDouble('doublePi'), Math.PI);
    assert.equal(col.getBool('bool'), false);
    assert.equal(col.getString('string'), 'hello');
    assert.deepStrictEqual(col.getRaw('raw'), Buffer.from([0, 1, 127, 128, 255]));
    assert.deepStrictEqual(col.getByteArray('byteArray'), [0, 128, 255]);
    assert.deepStrictEqual(col.getShortArray('shortArray'), [-32768, 0, 32767]);
    assert.deepStrictEqual(col.getIntArray('intArray'), [-2147483648, 2147483647]);
    assert.deepStrictEqual(col.getUIntArray('uintArray'), [0, 4294967295]);
    assert.deepStrictEqual(col.getLongArray('longArray'), [-(2n ** 63n), 2n ** 63n - 1n]);
    assert.deepStrictEqual(col.getULongArray('ulongArray'), [0n, 2n ** 64n - 1n]);
    assert.deepStrictEqual(col.getFloatArray('floatArray'), [NaN, Infinity, -Infinity, 1.5, -0.25]);
    assert.deepStrictEqual(col.getDoubleArray('doubleArray'), [-Infinity, NaN, Infinity, Math.PI]);
    assert.deepStrictEqual(col.getBoolArray('boolArray'), [true, false, true]);
    assert.deepStrictEqual(col.getStringArray('stringArray'), ['a', '', 'c']);
    assert.equal(col.getCollection('nested').getInt('seed'), 0);
    assert.equal(col.getCollection('nested').getString('label'), 'child-0');
    const items = col.getCollectionArray('nestedArray');
    assert.equal(items.length, 2);
    assert.equal(items[0].getInt('seed'), 1);
    assert.equal(items[1].getString('label'), 'child-2');
}

test('every one of the 23 kinds round-trips through add/get and serialize/deserialize', () => {
    const col = new FonCollection();
    fillAllKinds(col);
    assertAllKinds(col);

    const line = col.serialize();
    const restored = FonCollection.deserialize(line);
    assertAllKinds(restored);

    const dump = new FonDump();
    const dumpCol = new FonCollection();
    fillAllKinds(dumpCol);
    dump.add(0n, dumpCol);
    const dumpRestored = FonDump.deserialize(dump.serialize());
    assertAllKinds(dumpRestored.get(0n));

    col.free();
    restored.free();
    dump.free();
    dumpRestored.free();
});

test('kind() reports type names and the array flag for every kind', () => {
    const col = new FonCollection();
    fillAllKinds(col);
    assert.deepStrictEqual(col.kind('byteMin'), { type: 'byte', array: false });
    assert.deepStrictEqual(col.kind('longMax'), { type: 'long', array: false });
    assert.deepStrictEqual(col.kind('ulongArray'), { type: 'ulong', array: true });
    assert.deepStrictEqual(col.kind('raw'), { type: 'raw', array: false });
    assert.deepStrictEqual(col.kind('nested'), { type: 'object', array: false });
    assert.deepStrictEqual(col.kind('nestedArray'), { type: 'object', array: true });
    assert.equal(col.kind('missing'), null);
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

    // Retrieve the record view at id 0.
    const col2 = dump2.get(0n);
    assert.ok(col2 !== null, 'should have a record at id 0');

    assert.equal(col2.getInt('id'), 7);
    assert.equal(col2.getString('name'), 'Test Item');
    assert.ok(Math.abs(col2.getDouble('price') - 99.99) < 1e-6);

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
        assert.ok(col2 !== null, 'should have a record at id 0');
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
