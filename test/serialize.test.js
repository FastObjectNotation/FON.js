'use strict';

// Serialization tests (design section 6, items 7 and 8).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { FonCollection, FonDump, FonError, deserializeDumpFromFile } from '../src/index.js';

function buildDump(count) {
    const dump = new FonDump();
    for (let i = 0; i < count; i++) {
        const col = new FonCollection();
        col.addInt('i', i);
        col.addString('s', `record ${i} é \u0000 \\`);
        col.addDoubleArray('d', [i, i / 2]);
        dump.add(BigInt(i), col);
    }
    return dump;
}

test('maxThreads 1 and 2 serialize identically to 0', () => {
    const dump = buildDump(2000);
    const reference = dump.serialize(0);
    assert.equal(dump.serialize(1), reference);
    assert.equal(dump.serialize(2), reference);

    const restored = FonDump.deserialize(reference, 1);
    assert.equal(restored.serialize(0), reference);
    const restored2 = FonDump.deserialize(reference, 2);
    assert.equal(restored2.serialize(0), reference);

    dump.free();
    restored.free();
    restored2.free();
});

test('serializeToFile with maxThreads 1 and 2 writes the same content as 0', () => {
    const dump = buildDump(500);
    const files = [0, 1, 2].map((threads) => {
        const file = path.join(os.tmpdir(), `fon_threads_${threads}_${randomUUID()}.fon`);
        dump.serializeToFile(file, threads);
        return file;
    });
    try {
        const reference = dump.serialize(0);
        for (const file of files) {
            const restored = deserializeDumpFromFile(file, 1);
            assert.equal(restored.serialize(0), reference);
            restored.free();
        }
    } finally {
        for (const file of files) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        dump.free();
    }
});

test('deserializing a missing file throws FILE_NOT_FOUND', () => {
    const missing = path.join(os.tmpdir(), `fon_missing_${randomUUID()}.fon`);
    assert.throws(
        () => deserializeDumpFromFile(missing),
        (error) => error instanceof FonError && error.code === 'FILE_NOT_FOUND'
    );
    assert.throws(
        () => FonDump.deserializeFromFile(missing, 2),
        (error) => error instanceof FonError && error.code === 'FILE_NOT_FOUND'
    );
});

