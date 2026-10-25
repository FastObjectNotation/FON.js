/*
 * fon.h — C ABI of the fon_native library.
 *
 * Conventions (apply to every function below):
 *
 * Handles
 *   void* handles are opaque. A handle returned by *_create, *_clone or *_deserialize_*
 *   is OWNED by the caller and must be released with the matching *_free, unless its
 *   ownership is transferred into a parent by a successful put (see "Ownership").
 *   A handle returned by fon_dump_get, fon_collection_get_collection or
 *   fon_collection_get_collection_array is BORROWED: never free it, never put it into
 *   another container.
 *
 * Borrowed-handle lifetime
 *   - A borrowed RECORD handle from fon_dump_get is valid only until the next mutation
 *     of that dump (fon_dump_put/remove/remove_many/touch, or any put/remove on any
 *     collection inside it). Callers must re-resolve it with fon_dump_get after any
 *     mutation.
 *   - A borrowed NESTED handle (from fon_collection_get_collection[_array]) stays valid
 *     until a field anywhere in the tree of its root record (or root collection) is
 *     put/removed, or the root record is removed/replaced, or the root is freed.
 *     fon_dump_gens + fon_dump_touch let a caller detect this for records in a dump.
 *
 * Ownership
 *   Every function that accepts a child collection handle (put_collection,
 *   put_collection_array, fon_dump_put) takes ownership of it IF AND ONLY IF it
 *   returns FON_OK. On any error the caller still owns the child and must free it.
 *   The child must be an owned root handle (never a borrowed handle, never the target
 *   itself); the same handle must not appear twice in one children array.
 *
 * Strings
 *   Every string INPUT is passed as (const uint8_t* ptr, int64_t len): UTF-8, not
 *   NUL-terminated, may contain U+0000. len == 0 means the empty string and ptr may then
 *   be NULL. Invalid UTF-8 -> FON_ERROR_INVALID_ARGUMENT.
 *   Every string OUTPUT uses the size-query pattern below and is written WITHOUT a NUL
 *   terminator. Only fon_version() returns a NUL-terminated C string.
 *
 * Size-query pattern (string, raw, array and handle-array getters)
 *   (T* buffer, int64_t capacity, int64_t* actual)
 *   - `actual` must be non-NULL; on FON_OK and on FON_ERROR_BUFFER_TOO_SMALL it receives
 *     the exact required element count (bytes for strings/raw).
 *   - buffer == NULL: pure size query, returns FON_OK, writes nothing else.
 *   - buffer != NULL and capacity < required: returns FON_ERROR_BUFFER_TOO_SMALL and
 *     writes nothing into buffer. Values are NEVER truncated.
 *   - otherwise exactly `required` elements are written and FON_OK is returned.
 *
 * Multi-string pattern (fon_collection_keys, fon_collection_get_string_array)
 *   (int64_t* lengths, int64_t lengths_capacity, uint8_t* bytes, int64_t bytes_capacity,
 *    int64_t* count, int64_t* total_bytes)
 *   - `count` and `total_bytes` must be non-NULL and always receive the item count and
 *     the sum of all item byte lengths.
 *   - lengths == NULL or bytes == NULL (when total_bytes > 0): size query, FON_OK.
 *   - lengths_capacity < count or bytes_capacity < total_bytes: FON_ERROR_BUFFER_TOO_SMALL.
 *   - otherwise lengths[i] = byte length of item i, and items are written back to back
 *     into `bytes` in order (no separators, no NUL).
 *
 * Owned output buffers (serialize)
 *   *out receives a buffer allocated by the library and *out_len its length. Release it
 *   with fon_buffer_free(ptr, len). For empty output *out may be NULL and *out_len 0;
 *   fon_buffer_free(NULL, 0) is a no-op.
 *
 * Errors
 *   Functions returning int32_t return a FON_* code; on failure they fill *err (err may
 *   be NULL). Functions returning a handle return NULL on failure and fill *err.
 *
 * Threading
 *   Configuration setters are thread-safe. A dump or collection must not be mutated
 *   concurrently with any other access to the same tree.
 */

#ifndef FON_H
#define FON_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif


/* ==================== RESULT CODES ==================== */

#define FON_OK                      0
#define FON_ERROR_FILE_NOT_FOUND    1
#define FON_ERROR_PARSE_FAILED      2
#define FON_ERROR_WRITE_FAILED      3
#define FON_ERROR_INVALID_ARGUMENT  4
#define FON_ERROR_BUFFER_TOO_SMALL  5
#define FON_ERROR_NOT_FOUND         6   /* key or id absent */
#define FON_ERROR_TYPE_MISMATCH     7   /* key present, value has another type */
#define FON_ERROR_ALREADY_EXISTS    8   /* FON_PUT_ADD on an existing key or id */
#define FON_ERROR_STALE_VIEW        9   /* reserved for wrappers: a borrowed view outlived its target */


/* ==================== PUT MODES ==================== */

#define FON_PUT_ADD     0   /* key/id must not exist, else FON_ERROR_ALREADY_EXISTS */
#define FON_PUT_SET     1   /* key/id must exist, else FON_ERROR_NOT_FOUND; value is replaced (type may change) */
#define FON_PUT_UPSERT  2   /* replace if present, add if absent */


/* ==================== VALUE KINDS ==================== */
/* kind = type char | (is_array ? FON_KIND_ARRAY : 0); -1 = key absent */

#define FON_TYPE_BYTE    'e'   /* uint8_t  */
#define FON_TYPE_SHORT   't'   /* int16_t  */
#define FON_TYPE_INT     'i'   /* int32_t  */
#define FON_TYPE_UINT    'u'   /* uint32_t */
#define FON_TYPE_LONG    'l'   /* int64_t  */
#define FON_TYPE_ULONG   'g'   /* uint64_t */
#define FON_TYPE_FLOAT   'f'   /* float    */
#define FON_TYPE_DOUBLE  'd'   /* double   */
#define FON_TYPE_BOOL    'b'   /* 0 / 1    */
#define FON_TYPE_STRING  's'
#define FON_TYPE_RAW     'r'   /* binary blob; no array form */
#define FON_TYPE_OBJECT  'o'   /* nested collection */
#define FON_KIND_ARRAY   0x100


/* ==================== ERROR STRUCT ==================== */

typedef struct FonError {
    int32_t code;
    char    message[256];   /* UTF-8, NUL-terminated, truncated to fit */
} FonError;


/* ==================== VERSION / CONFIG / BUFFERS ==================== */

const char* fon_version(void);                 /* static, NUL-terminated, e.g. "0.4.0" */
void        fon_set_raw_unpack(int32_t enable);  /* decode raw blobs during parse */
void        fon_set_max_depth(int32_t depth);    /* clamped to >= 1; default 64 */
void        fon_buffer_free(uint8_t* ptr, int64_t len);


/* ==================== COLLECTION: LIFECYCLE / INTROSPECTION ==================== */

void*   fon_collection_create(void);
void    fon_collection_free(void* collection);
int64_t fon_collection_size(void* collection);
void*   fon_collection_clone(void* collection, FonError* err);   /* deep copy, OWNED */

int32_t fon_collection_kind_of(void* collection, const uint8_t* key, int64_t key_len);

/* Keys in insertion order (multi-string pattern). `kinds` may be NULL; when non-NULL
 * and lengths_capacity >= count, kinds[i] receives the kind of key i. */
int32_t fon_collection_keys(void* collection,
                            int64_t* lengths, int64_t lengths_capacity,
                            uint8_t* bytes, int64_t bytes_capacity,
                            int32_t* kinds,
                            int64_t* count, int64_t* total_bytes,
                            FonError* err);

/* 1 = removed, 0 = absent (or NULL collection). */
int32_t fon_collection_remove(void* collection, const uint8_t* key, int64_t key_len);


/* ==================== COLLECTION: PUT ==================== */

int32_t fon_collection_put_byte  (void* c, const uint8_t* key, int64_t key_len, uint8_t  value, int32_t mode, FonError* err);
int32_t fon_collection_put_short (void* c, const uint8_t* key, int64_t key_len, int16_t  value, int32_t mode, FonError* err);
int32_t fon_collection_put_int   (void* c, const uint8_t* key, int64_t key_len, int32_t  value, int32_t mode, FonError* err);
int32_t fon_collection_put_uint  (void* c, const uint8_t* key, int64_t key_len, uint32_t value, int32_t mode, FonError* err);
int32_t fon_collection_put_long  (void* c, const uint8_t* key, int64_t key_len, int64_t  value, int32_t mode, FonError* err);
int32_t fon_collection_put_ulong (void* c, const uint8_t* key, int64_t key_len, uint64_t value, int32_t mode, FonError* err);
int32_t fon_collection_put_float (void* c, const uint8_t* key, int64_t key_len, float    value, int32_t mode, FonError* err);
int32_t fon_collection_put_double(void* c, const uint8_t* key, int64_t key_len, double   value, int32_t mode, FonError* err);
int32_t fon_collection_put_bool  (void* c, const uint8_t* key, int64_t key_len, int32_t  value, int32_t mode, FonError* err);
int32_t fon_collection_put_string(void* c, const uint8_t* key, int64_t key_len, const uint8_t* value, int64_t value_len, int32_t mode, FonError* err);
int32_t fon_collection_put_raw   (void* c, const uint8_t* key, int64_t key_len, const uint8_t* data,  int64_t data_len,  int32_t mode, FonError* err);

int32_t fon_collection_put_byte_array  (void* c, const uint8_t* key, int64_t key_len, const uint8_t*  values, int64_t count, int32_t mode, FonError* err);
int32_t fon_collection_put_short_array (void* c, const uint8_t* key, int64_t key_len, const int16_t*  values, int64_t count, int32_t mode, FonError* err);
int32_t fon_collection_put_int_array   (void* c, const uint8_t* key, int64_t key_len, const int32_t*  values, int64_t count, int32_t mode, FonError* err);
int32_t fon_collection_put_uint_array  (void* c, const uint8_t* key, int64_t key_len, const uint32_t* values, int64_t count, int32_t mode, FonError* err);
int32_t fon_collection_put_long_array  (void* c, const uint8_t* key, int64_t key_len, const int64_t*  values, int64_t count, int32_t mode, FonError* err);
int32_t fon_collection_put_ulong_array (void* c, const uint8_t* key, int64_t key_len, const uint64_t* values, int64_t count, int32_t mode, FonError* err);
int32_t fon_collection_put_float_array (void* c, const uint8_t* key, int64_t key_len, const float*    values, int64_t count, int32_t mode, FonError* err);
int32_t fon_collection_put_double_array(void* c, const uint8_t* key, int64_t key_len, const double*   values, int64_t count, int32_t mode, FonError* err);
int32_t fon_collection_put_bool_array  (void* c, const uint8_t* key, int64_t key_len, const uint8_t*  values, int64_t count, int32_t mode, FonError* err);   /* 0 / non-zero */

/* Items given as lengths[count] plus all item bytes back to back in `bytes`. */
int32_t fon_collection_put_string_array(void* c, const uint8_t* key, int64_t key_len,
                                        const int64_t* lengths, const uint8_t* bytes, int64_t count,
                                        int32_t mode, FonError* err);

/* Ownership of child / every child transfers to `c` iff FON_OK. */
int32_t fon_collection_put_collection(void* c, const uint8_t* key, int64_t key_len, void* child, int32_t mode, FonError* err);
int32_t fon_collection_put_collection_array(void* c, const uint8_t* key, int64_t key_len,
                                            void* const* children, int64_t count,
                                            int32_t mode, FonError* err);


/* ==================== COLLECTION: GET ==================== */
/* Absent key -> FON_ERROR_NOT_FOUND; other type -> FON_ERROR_TYPE_MISMATCH. */

int32_t fon_collection_get_byte  (void* c, const uint8_t* key, int64_t key_len, uint8_t*  out, FonError* err);
int32_t fon_collection_get_short (void* c, const uint8_t* key, int64_t key_len, int16_t*  out, FonError* err);
int32_t fon_collection_get_int   (void* c, const uint8_t* key, int64_t key_len, int32_t*  out, FonError* err);
int32_t fon_collection_get_uint  (void* c, const uint8_t* key, int64_t key_len, uint32_t* out, FonError* err);
int32_t fon_collection_get_long  (void* c, const uint8_t* key, int64_t key_len, int64_t*  out, FonError* err);
int32_t fon_collection_get_ulong (void* c, const uint8_t* key, int64_t key_len, uint64_t* out, FonError* err);
int32_t fon_collection_get_float (void* c, const uint8_t* key, int64_t key_len, float*    out, FonError* err);
int32_t fon_collection_get_double(void* c, const uint8_t* key, int64_t key_len, double*   out, FonError* err);
int32_t fon_collection_get_bool  (void* c, const uint8_t* key, int64_t key_len, int32_t*  out, FonError* err);

/* Size-query pattern. get_raw returns decoded bytes even if the blob is stored Z85-packed. */
int32_t fon_collection_get_string(void* c, const uint8_t* key, int64_t key_len, uint8_t* buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_raw   (void* c, const uint8_t* key, int64_t key_len, uint8_t* buffer, int64_t capacity, int64_t* actual, FonError* err);

int32_t fon_collection_get_byte_array  (void* c, const uint8_t* key, int64_t key_len, uint8_t*  buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_short_array (void* c, const uint8_t* key, int64_t key_len, int16_t*  buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_int_array   (void* c, const uint8_t* key, int64_t key_len, int32_t*  buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_uint_array  (void* c, const uint8_t* key, int64_t key_len, uint32_t* buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_long_array  (void* c, const uint8_t* key, int64_t key_len, int64_t*  buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_ulong_array (void* c, const uint8_t* key, int64_t key_len, uint64_t* buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_float_array (void* c, const uint8_t* key, int64_t key_len, float*    buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_double_array(void* c, const uint8_t* key, int64_t key_len, double*   buffer, int64_t capacity, int64_t* actual, FonError* err);
int32_t fon_collection_get_bool_array  (void* c, const uint8_t* key, int64_t key_len, uint8_t*  buffer, int64_t capacity, int64_t* actual, FonError* err);   /* 0 / 1 */

/* Multi-string pattern. */
int32_t fon_collection_get_string_array(void* c, const uint8_t* key, int64_t key_len,
                                        int64_t* lengths, int64_t lengths_capacity,
                                        uint8_t* bytes, int64_t bytes_capacity,
                                        int64_t* count, int64_t* total_bytes,
                                        FonError* err);

/* BORROWED handles (see "Borrowed-handle lifetime"). NULL + err on failure. */
void*   fon_collection_get_collection(void* c, const uint8_t* key, int64_t key_len, FonError* err);
int32_t fon_collection_get_collection_array(void* c, const uint8_t* key, int64_t key_len,
                                            void** buffer, int64_t capacity, int64_t* actual,
                                            FonError* err);


/* ==================== DUMP ==================== */

void*   fon_dump_create(void);
void    fon_dump_free(void* dump);
int64_t fon_dump_size(void* dump);   /* live records */

/* All live ids in ascending order (size-query pattern). */
int32_t fon_dump_ids(void* dump, uint64_t* buffer, int64_t capacity, int64_t* actual, FonError* err);

/* BORROWED record handle, NULL if absent. Valid only until the next mutation of the dump. */
void*   fon_dump_get(void* dump, uint64_t id);

/* ADD: id must be absent. SET: id must be live (replace). UPSERT: either.
 * Ownership of `collection` transfers to the dump iff FON_OK. */
int32_t fon_dump_put(void* dump, uint64_t id, void* collection, int32_t mode, FonError* err);

int32_t fon_dump_remove(void* dump, uint64_t id);                              /* 1 removed, 0 absent */
int64_t fon_dump_remove_many(void* dump, const uint64_t* ids, int64_t count);  /* live records removed */

/* View validation. record_gen changes when the record is removed/replaced; tree_gen
 * changes on fon_dump_touch. Return 1 (live, gens written) or 0 (absent). */
int32_t fon_dump_gens(void* dump, uint64_t id, uint32_t* record_gen, uint32_t* tree_gen);
/* Call after any put/remove on a collection inside record `id`. 1 live, 0 absent. */
int32_t fon_dump_touch(void* dump, uint64_t id);


/* ==================== SERIALIZE / DESERIALIZE ==================== */
/* max_threads <= 0 uses all cores; > 0 caps the worker threads for this call. */

int32_t fon_serialize_dump(void* dump, int32_t max_threads, uint8_t** out, int64_t* out_len, FonError* err);
int32_t fon_serialize_collection(void* collection, uint8_t** out, int64_t* out_len, FonError* err);
int32_t fon_serialize_to_file(void* dump, const uint8_t* path, int64_t path_len, int32_t max_threads, FonError* err);

void*   fon_deserialize_dump(const uint8_t* data, int64_t len, int32_t max_threads, FonError* err);   /* OWNED */
void*   fon_deserialize_collection(const uint8_t* data, int64_t len, FonError* err);                  /* OWNED */
void*   fon_deserialize_from_file(const uint8_t* path, int64_t path_len, int32_t max_threads, FonError* err); /* OWNED; missing file -> FON_ERROR_FILE_NOT_FOUND */


#ifdef __cplusplus
}
#endif

#endif /* FON_H */
