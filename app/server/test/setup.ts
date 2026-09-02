/**
 * Test bootstrap: point at the dedicated test database and reset the schema
 * once per run, so integration tests exercise real SQL, real RLS and real
 * constraints rather than mocks.
 */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??= 'postgres://outcome:outcome@127.0.0.1:5432/outcome_test';
process.env['SESSION_SECRET'] ??= 'test-secret-must-be-at-least-32-characters-long';
process.env['AI_PROVIDER'] = 'fake';
process.env['LOG_LEVEL'] = 'silent';
process.env['COOKIE_SECURE'] = 'false';
