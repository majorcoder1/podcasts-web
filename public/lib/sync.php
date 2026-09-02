<?php
/**
 * Sync. One endpoint: push whatever changed locally, pull whatever changed
 * elsewhere since the caller's cursor.
 *
 * Two clocks per row. `updated_at` is the server's, and drives the pull cursor,
 * so a device with a wrong clock can never hide its rows from other devices.
 * `client_updated_at` is the device's, and decides conflicts: last write wins.
 *
 * Only touched episodes sync - one with a saved position, or marked played,
 * archived or queued. A 500-episode feed does not become 500 rows.
 */

declare(strict_types=1);

if (!defined('PODCAST_APP')) {
    http_response_code(404);
    exit;
}

const SYNC_PAGE = 1000;

function ms(): int
{
    return (int) round(microtime(true) * 1000);
}

function as_int($value, int $fallback = 0): int
{
    if (is_int($value)) {
        return $value;
    }
    if (is_float($value)) {
        return (int) $value;
    }
    if (is_string($value) && preg_match('/^-?\d+$/', $value)) {
        return (int) $value;
    }
    return $fallback;
}

function as_bool($value): int
{
    return !empty($value) && $value !== 'false' ? 1 : 0;
}

function as_text($value, int $limit): string
{
    return is_scalar($value) ? substr((string) $value, 0, $limit) : '';
}

// ---- push -----------------------------------------------------------------

function push_subscriptions(int $userId, array $rows, int $serverNow): int
{
    $select = db()->prepare(
        'SELECT client_updated_at FROM subscriptions WHERE user_id = ? AND feed_url = ?'
    );
    $upsert = db()->prepare(
        'REPLACE INTO subscriptions
            (user_id, feed_url, title, author, image_url, subscribed, deleted,
             auto_download, notify, client_updated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    $written = 0;
    foreach ($rows as $row) {
        $feedUrl = as_text(isset($row['feedUrl']) ? $row['feedUrl'] : '', 500);
        if ($feedUrl === '') {
            continue;
        }
        $clientAt = as_int(isset($row['updatedAt']) ? $row['updatedAt'] : 0);

        $select->execute(array($userId, $feedUrl));
        $existing = $select->fetch();
        if ($existing && (int) $existing['client_updated_at'] > $clientAt) {
            continue;   // the stored copy is newer; leave it alone
        }

        $upsert->execute(array(
            $userId,
            $feedUrl,
            as_text(isset($row['title']) ? $row['title'] : '', 300),
            as_text(isset($row['author']) ? $row['author'] : '', 300),
            as_text(isset($row['imageUrl']) ? $row['imageUrl'] : '', 500),
            as_bool(isset($row['isSubscribed']) ? $row['isSubscribed'] : false),
            as_bool(isset($row['deleted']) ? $row['deleted'] : false),
            as_bool(isset($row['autoDownload']) ? $row['autoDownload'] : false),
            as_bool(isset($row['notifyNewEpisodes']) ? $row['notifyNewEpisodes'] : true),
            $clientAt,
            $serverNow,
        ));
        $written++;
    }
    return $written;
}

function push_episodes(int $userId, array $rows, int $serverNow): int
{
    $select = db()->prepare(
        'SELECT client_updated_at FROM episode_state WHERE user_id = ? AND guid = ?'
    );
    $upsert = db()->prepare(
        'REPLACE INTO episode_state
            (user_id, guid, feed_url, position_ms, duration_ms, completed, archived,
             last_played_at, client_updated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    $written = 0;
    foreach ($rows as $row) {
        $guid = as_text(isset($row['guid']) ? $row['guid'] : '', 500);
        if ($guid === '') {
            continue;
        }
        $clientAt = as_int(isset($row['updatedAt']) ? $row['updatedAt'] : 0);

        $select->execute(array($userId, $guid));
        $existing = $select->fetch();
        if ($existing && (int) $existing['client_updated_at'] > $clientAt) {
            continue;
        }

        $upsert->execute(array(
            $userId,
            $guid,
            as_text(isset($row['feedUrl']) ? $row['feedUrl'] : '', 500),
            max(0, as_int(isset($row['positionMs']) ? $row['positionMs'] : 0)),
            max(0, as_int(isset($row['durationMs']) ? $row['durationMs'] : 0)),
            as_bool(isset($row['isCompleted']) ? $row['isCompleted'] : false),
            as_bool(isset($row['isArchived']) ? $row['isArchived'] : false),
            as_int(isset($row['lastPlayedAt']) ? $row['lastPlayedAt'] : 0),
            $clientAt,
            $serverNow,
        ));
        $written++;
    }
    return $written;
}

function push_queue(int $userId, array $rows, int $serverNow): int
{
    $select = db()->prepare(
        'SELECT client_updated_at FROM queue_items WHERE user_id = ? AND guid = ?'
    );
    $upsert = db()->prepare(
        'REPLACE INTO queue_items (user_id, guid, position, removed, client_updated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)'
    );

    $written = 0;
    foreach ($rows as $row) {
        $guid = as_text(isset($row['guid']) ? $row['guid'] : '', 500);
        if ($guid === '') {
            continue;
        }
        $clientAt = as_int(isset($row['updatedAt']) ? $row['updatedAt'] : 0);

        $select->execute(array($userId, $guid));
        $existing = $select->fetch();
        if ($existing && (int) $existing['client_updated_at'] > $clientAt) {
            continue;
        }

        $upsert->execute(array(
            $userId,
            $guid,
            as_int(isset($row['position']) ? $row['position'] : 0),
            as_bool(isset($row['removed']) ? $row['removed'] : false),
            $clientAt,
            $serverNow,
        ));
        $written++;
    }
    return $written;
}

function push_settings(int $userId, $settings, int $serverNow): void
{
    if (!is_array($settings) || !isset($settings['payload'])) {
        return;
    }
    $clientAt = as_int(isset($settings['updatedAt']) ? $settings['updatedAt'] : 0);

    $select = db()->prepare('SELECT client_updated_at FROM user_settings WHERE user_id = ?');
    $select->execute(array($userId));
    $existing = $select->fetch();
    if ($existing && (int) $existing['client_updated_at'] > $clientAt) {
        return;
    }

    $payload = json_encode($settings['payload']);
    if ($payload === false || strlen($payload) > 65535) {
        return;
    }

    db()->prepare(
        'REPLACE INTO user_settings (user_id, payload, client_updated_at, updated_at)
         VALUES (?, ?, ?, ?)'
    )->execute(array($userId, $payload, $clientAt, $serverNow));
}

// ---- pull -----------------------------------------------------------------

function pull_all(int $userId, int $since): array
{
    $pdo = db();
    $truncated = false;

    $fetch = function (string $sql) use ($pdo, $userId, $since, &$truncated) {
        $statement = $pdo->prepare($sql);
        $statement->execute(array($userId, $since));
        $rows = $statement->fetchAll();
        if (count($rows) >= SYNC_PAGE) {
            $truncated = true;
        }
        return $rows;
    };

    $subs = $fetch(
        'SELECT feed_url, title, author, image_url, subscribed, deleted, auto_download,
                notify, client_updated_at, updated_at
         FROM subscriptions WHERE user_id = ? AND updated_at > ?
         ORDER BY updated_at ASC LIMIT ' . SYNC_PAGE
    );
    $episodes = $fetch(
        'SELECT guid, feed_url, position_ms, duration_ms, completed, archived,
                last_played_at, client_updated_at, updated_at
         FROM episode_state WHERE user_id = ? AND updated_at > ?
         ORDER BY updated_at ASC LIMIT ' . SYNC_PAGE
    );
    $queue = $fetch(
        'SELECT guid, position, removed, client_updated_at, updated_at
         FROM queue_items WHERE user_id = ? AND updated_at > ?
         ORDER BY updated_at ASC LIMIT ' . SYNC_PAGE
    );

    $settingsStatement = $pdo->prepare(
        'SELECT payload, client_updated_at FROM user_settings WHERE user_id = ? AND updated_at > ?'
    );
    $settingsStatement->execute(array($userId, $since));
    $settingsRow = $settingsStatement->fetch();

    return array(
        'subscriptions' => array_map(function ($row) {
            return array(
                'feedUrl'            => $row['feed_url'],
                'title'              => $row['title'],
                'author'             => $row['author'],
                'imageUrl'           => $row['image_url'],
                'isSubscribed'       => (bool) $row['subscribed'],
                'deleted'            => (bool) $row['deleted'],
                'autoDownload'       => (bool) $row['auto_download'],
                'notifyNewEpisodes'  => (bool) $row['notify'],
                'updatedAt'          => (int) $row['client_updated_at'],
            );
        }, $subs),
        'episodes' => array_map(function ($row) {
            return array(
                'guid'         => $row['guid'],
                'feedUrl'      => $row['feed_url'],
                'positionMs'   => (int) $row['position_ms'],
                'durationMs'   => (int) $row['duration_ms'],
                'isCompleted'  => (bool) $row['completed'],
                'isArchived'   => (bool) $row['archived'],
                'lastPlayedAt' => (int) $row['last_played_at'],
                'updatedAt'    => (int) $row['client_updated_at'],
            );
        }, $episodes),
        'queue' => array_map(function ($row) {
            return array(
                'guid'      => $row['guid'],
                'position'  => (int) $row['position'],
                'removed'   => (bool) $row['removed'],
                'updatedAt' => (int) $row['client_updated_at'],
            );
        }, $queue),
        'settings' => $settingsRow
            ? array(
                'payload'   => json_decode($settingsRow['payload'], true),
                'updatedAt' => (int) $settingsRow['client_updated_at'],
            )
            : null,
        'truncated' => $truncated,
    );
}

function handle_sync(): void
{
    $user   = require_user();
    $userId = (int) $user['id'];
    $method = $_SERVER['REQUEST_METHOD'];

    $serverNow = ms();
    $written   = 0;

    if ($method === 'POST') {
        $input = json_input();
        $since = as_int(isset($input['since']) ? $input['since'] : 0);

        $pdo = db();
        $pdo->beginTransaction();
        try {
            if (!empty($input['subscriptions']) && is_array($input['subscriptions'])) {
                $written += push_subscriptions($userId, $input['subscriptions'], $serverNow);
            }
            if (!empty($input['episodes']) && is_array($input['episodes'])) {
                $written += push_episodes($userId, $input['episodes'], $serverNow);
            }
            if (!empty($input['queue']) && is_array($input['queue'])) {
                $written += push_queue($userId, $input['queue'], $serverNow);
            }
            if (isset($input['settings'])) {
                push_settings($userId, $input['settings'], $serverNow);
            }
            $pdo->commit();
        } catch (PDOException $error) {
            $pdo->rollBack();
            fail(500, 'Could not save your changes');
        }
    } else {
        $since = as_int(isset($_GET['since']) ? $_GET['since'] : 0);
    }

    // Pull with the caller's original cursor. Rows the caller just pushed come
    // back too, which is harmless: merging is idempotent, and it confirms what
    // the server actually stored.
    $changes = pull_all($userId, $since);
    $changes['written']    = $written;
    $changes['serverTime'] = ms();
    json_out($changes);
}
