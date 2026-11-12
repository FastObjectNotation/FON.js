// Malformed text is an error, an empty line is an empty record, and values that cannot be
// stored as given are rejected instead of being altered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonCollection, FonDump, FonError } from '../src/index.js';

const PARSE_FAILED = 'PARSE_FAILED';

test('malformed records are rejected, including the bool array that used to hang', () => {
    const lines = [
        'a=b:[[]]',
        'a=i:12abc',
        'a=i:+',
        'a=b:false',
        'a=i:1,junk',
        'a=i:1,a=i:2',
        'a=i:1,',
        'a=i:[1,,2]',
        'a=s:"\\q"',
    ];
    for (const line of lines) {
        assert.throws(
            () => FonCollection.deserialize(line),
            (error) => error instanceof FonError && error.code === PARSE_FAILED,
            `${line} was accepted`
        );
    }
});

test('a parse error in a dump names the line for every thread count', () => {
    for (const threads of [1, 2, 0]) {
        assert.throws(
            () => FonDump.deserialize('a=i:1\na=b:[[]]\nc=i:3\n', threads),
            (error) => error instanceof FonError && error.message.startsWith('line 2: ')
        );
    }
});

test('an empty record survives a save and load', () => {
    const dump = new FonDump();
    dump.add(0, new FonCollection().addInt('x', 1));
    dump.add(1, new FonCollection());
    dump.add(2, new FonCollection().addInt('x', 3));

    const text = dump.serialize();
    assert.equal(text.toString(), 'x=i:1\n\nx=i:3\n');

    const loaded = FonDump.deserialize(text);
    assert.equal(loaded.size, 3);
    assert.equal(loaded.get(1).size, 0);
    assert.equal(loaded.get(2).getInt('x'), 3);
    loaded.free();
    dump.free();
});

test('a lone surrogate in a value, an array item or a key is a TypeError', () => {
    const collection = new FonCollection();
    assert.throws(() => collection.addString('s', 'a\uD800b'), TypeError);
    assert.throws(() => collection.addString('k\uDC00', 'v'), TypeError);
    assert.throws(() => collection.addStringArray('list', ['ok', '\uD83D']), TypeError);
    assert.throws(() => collection.addInt('n\uD800', 1), TypeError);
    assert.equal(collection.size, 0);

    collection.addString('ok', 'pair 😀');
    assert.equal(collection.getString('ok'), 'pair 😀');
    collection.free();
});

test('bool setters take only true or false', () => {
    const collection = new FonCollection();
    for (const value of ['false', 0, 1, null, undefined, 'x']) {
        assert.throws(() => collection.addBool('b', value), TypeError);
        assert.throws(() => collection.setBool('b', value), TypeError);
    }
    assert.throws(() => collection.addBoolArray('list', [true, 'false']), TypeError);
    assert.throws(() => collection.setBoolArray('list', [1, 0]), TypeError);
    assert.equal(collection.size, 0);

    collection.addBool('b', false).addBoolArray('list', [true, false]);
    assert.equal(collection.getBool('b'), false);
    assert.deepEqual(collection.getBoolArray('list'), [true, false]);
    collection.free();
});

test('a finite number outside the 32-bit float range is a RangeError', () => {
    const collection = new FonCollection();
    assert.throws(() => collection.addFloat('f', 1e39), RangeError);
    assert.throws(() => collection.setFloat('f', -1e39), RangeError);
    assert.throws(() => collection.addFloatArray('list', [1, 3.5e38]), RangeError);
    assert.equal(collection.size, 0);

    collection.addFloat('max', 3.4028234663852886e38).addFloat('inf', Infinity).addFloat('nan', NaN);
    assert.equal(collection.getFloat('max'), 3.4028234663852886e38);
    assert.equal(collection.getFloat('inf'), Infinity);
    assert.ok(Number.isNaN(collection.getFloat('nan')));
    collection.free();
});

test('a collection cannot be stored inside its own nested collection', () => {
    const root = new FonCollection();
    root.addCollection('middle', new FonCollection().addCollection('leaf', new FonCollection()));
    const leaf = root.getCollection('middle').getCollection('leaf');

    assert.throws(() => leaf.addCollection('back', root));
    assert.throws(() => leaf.addCollectionArray('backs', [root]));
    assert.equal(root.serialize().toString(), 'middle=o:{leaf=o:{}}');
    root.free();
});
