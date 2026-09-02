<?php
/**
 * Storage. SQLite by default - a single file, no credentials, nothing to set up
 * in the control panel. If the host lacks the SQLite PDO driver, drop MySQL
 * credentials into data/db.php and it switches over without other changes.
 */

declare(strict_types=1);

if (!defined('PODCAST_APP')) {
    http_response_code(404);
    exit;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dir = data_dir();
    if ($dir === null) {
        fail(500, 'No writable data directory on this host');
    }

    $override = $dir . '/db.php';
    $config = is_file($override) ? include $override : array();
    $driver = isset($config['driver']) ? $config['driver'] : 'sqlite';

    try {
        if ($driver === 'mysql') {
            $dsn = sprintf(
                'mysql:host=%s;dbname=%s;charset=utf8mb4',
                $config['host'],
                $config['database']
            );
            $pdo = new PDO($dsn, $config['username'], $config['password']);
        } else {
            if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
                fail(500, 'This host has no SQLite PDO driver; add MySQL credentials to data/db.php');
            }
            $pdo = new PDO('sqlite:' . $dir . '/podcasts.sqlite');
            $pdo->exec('PRAGMA journal_mode = WAL');
            $pdo->exec('PRAGMA busy_timeout = 5000');
            $pdo->exec('PRAGMA foreign_keys = ON');
        }
    } catch (PDOException $error) {
        fail(500, 'Could not open the database');
    }

    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

    migrate($pdo, $driver);
    return $pdo;
}

function migrate(PDO $pdo, string $driver): void
{
    $pk = $driver === 'mysql'
        ? 'INTEGER PRIMARY KEY AUTO_INCREMENT'
        : 'INTEGER PRIMARY KEY AUTOINCREMENT';

    $statements = array(
        "CREATE TABLE IF NOT EXISTS users (
            id $pk,
            username VARCHAR(64) NOT NULL UNIQUE,
            display_name VARCHAR(120) NOT NULL DEFAULT '',
            password_hash VARCHAR(255) NOT NULL,
            created_at BIGINT NOT NULL,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until BIGINT NOT NULL DEFAULT 0
        )",
        "CREATE TABLE IF NOT EXISTS tokens (
            id $pk,
            user_id INTEGER NOT NULL,
            token_hash VARCHAR(64) NOT NULL UNIQUE,
            device VARCHAR(64) NOT NULL DEFAULT '',
            created_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL,
            last_used_at BIGINT NOT NULL
        )",
        "CREATE TABLE IF NOT EXISTS subscriptions (
            user_id INTEGER NOT NULL,
            feed_url VARCHAR(500) NOT NULL,
            title VARCHAR(300) NOT NULL DEFAULT '',
            author VARCHAR(300) NOT NULL DEFAULT '',
            image_url VARCHAR(500) NOT NULL DEFAULT '',
            subscribed INTEGER NOT NULL DEFAULT 1,
            deleted INTEGER NOT NULL DEFAULT 0,
            auto_download INTEGER NOT NULL DEFAULT 0,
            notify INTEGER NOT NULL DEFAULT 1,
            client_updated_at BIGINT NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (user_id, feed_url)
        )",
        "CREATE TABLE IF NOT EXISTS episode_state (
            user_id INTEGER NOT NULL,
            guid VARCHAR(500) NOT NULL,
            feed_url VARCHAR(500) NOT NULL DEFAULT '',
            position_ms INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            completed INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            last_played_at BIGINT NOT NULL DEFAULT 0,
            client_updated_at BIGINT NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (user_id, guid)
        )",
        "CREATE TABLE IF NOT EXISTS queue_items (
            user_id INTEGER NOT NULL,
            guid VARCHAR(500) NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            removed INTEGER NOT NULL DEFAULT 0,
            client_updated_at BIGINT NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (user_id, guid)
        )",
        "CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER NOT NULL PRIMARY KEY,
            payload TEXT NOT NULL,
            client_updated_at BIGINT NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL
        )",
    );

    foreach ($statements as $sql) {
        $pdo->exec($sql);
    }

    // Sync pulls are always "everything changed since X", so every synced table
    // is indexed on (user_id, updated_at).
    $indexes = array(
        'CREATE INDEX IF NOT EXISTS idx_subs_updated ON subscriptions (user_id, updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_episodes_updated ON episode_state (user_id, updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_queue_updated ON queue_items (user_id, updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id)',
    );
    foreach ($indexes as $sql) {
        try {
            $pdo->exec($sql);
        } catch (PDOException $error) {
            // MySQL below 8.0 has no IF NOT EXISTS for indexes; harmless.
        }
    }
}
