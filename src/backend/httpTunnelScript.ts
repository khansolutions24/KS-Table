// Source of ks_tunnel.php, offered as a download from the connection dialog's HTTP tab.
// Kept as a plain string (not a file on disk) so packaging needs no extra resources.

export const KS_TUNNEL_PHP = `<?php
/**
 * KS Table HTTP tunnel
 * ---------------------
 * Lets KS Table reach a MySQL/MariaDB server through this web server when the
 * database port itself is not reachable from your machine (e.g. shared hosting
 * that only exposes port 80/443).
 *
 * Setup:
 *   1. Upload this file to a PHP 7.4+ web server with the mysqli extension.
 *   2. Change TUNNEL_USER and TUNNEL_PASSWORD below to values of your own.
 *   3. In KS Table, open the connection's "HTTP" tab, enable the tunnel, and
 *      enter this file's URL plus the user/password you set here.
 *   4. Serve this file over HTTPS - both the tunnel password and every query
 *      travel through it otherwise unencrypted.
 *
 * Limitation: a plain PHP script has no long-running process to keep sessions
 * apart, so this script reuses one persistent MySQL link per (host, port,
 * user, password) combination. If several KS Table tabs use the same
 * connection at the same time, they can end up sharing that MySQL connection.
 * That is fine for browsing and editing, but transactions and session
 * variables are not guaranteed to stay isolated between tabs. Prefer an SSH
 * tunnel or a direct connection when that isolation matters.
 */

declare(strict_types=1);

// ---- change these two before uploading ----
const TUNNEL_USER = 'change-me';
const TUNNEL_PASSWORD = 'change-me-too';
// --------------------------------------------

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function ks_fail(int $status, string $message, array $extra = []): void {
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => array_merge(['message' => $message], $extra)]);
    exit;
}

if (!function_exists('mysqli_connect')) {
    ks_fail(500, 'The mysqli PHP extension is not enabled on this server.');
}

$authUser = $_SERVER['PHP_AUTH_USER'] ?? '';
$authPass = $_SERVER['PHP_AUTH_PW'] ?? '';
if (!hash_equals(TUNNEL_USER, $authUser) || !hash_equals(TUNNEL_PASSWORD, $authPass)) {
    header('WWW-Authenticate: Basic realm="KS Table tunnel"');
    ks_fail(401, 'Unauthorized');
}

$body = file_get_contents('php://input') ?: '';
if (($_SERVER['HTTP_X_KS_ENCODING'] ?? '') === 'base64') {
    $decoded = base64_decode($body, true);
    if ($decoded === false) {
        ks_fail(400, 'Bad request body');
    }
    $body = $decoded;
}
$req = json_decode($body, true);
if (!is_array($req) || !isset($req['action'])) {
    ks_fail(400, 'Bad request');
}
$action = (string) $req['action'];

function ks_str(array $req, string $key, string $default = ''): string {
    return isset($req[$key]) ? (string) $req[$key] : $default;
}

function ks_connect(string $host, int $port, string $user, string $password, string $charset): mysqli {
    mysqli_report(MYSQLI_REPORT_OFF);
    // "p:" makes this a persistent link, reused by later requests with the same parameters.
    $conn = @mysqli_connect('p:' . $host, $user, $password, '', $port);
    if (!$conn) {
        ks_fail(502, 'MySQL connect failed: ' . mysqli_connect_error(), ['fatal' => true]);
    }
    @mysqli_set_charset($conn, $charset !== '' ? $charset : 'utf8mb4');
    return $conn;
}

function ks_is_binary(int $type, int $charsetNr): bool {
    if ($type === 16 || $type === 255) {
        return true; // BIT, GEOMETRY
    }
    $isStringish = $type === 15 || $type === 253 || $type === 254 || ($type >= 249 && $type <= 252);
    return $isStringish && $charsetNr === 63;
}

function ks_field(object $f): array {
    return [
        'name' => $f->name,
        'orgName' => $f->orgname,
        'table' => $f->table,
        'orgTable' => $f->orgtable,
        'schema' => $f->db ?? '',
        'type' => $f->type,
        'flags' => $f->flags,
        'charsetNr' => $f->charsetnr,
        'length' => $f->length,
        'decimals' => $f->decimals
    ];
}

switch ($action) {
    case 'connect': {
        $host = ks_str($req, 'host');
        $port = (int) ($req['port'] ?? 3306);
        $user = ks_str($req, 'user');
        $password = ks_str($req, 'password');
        $charset = ks_str($req, 'charset', 'utf8mb4');
        if ($host === '' || $user === '') {
            ks_fail(400, 'host and user are required');
        }
        $conn = ks_connect($host, $port, $user, $password, $charset);
        echo json_encode(['ok' => true, 'threadId' => mysqli_thread_id($conn), 'serverInfo' => mysqli_get_server_info($conn)]);
        break;
    }

    case 'ping':
    case 'close': {
        // The MySQL link is a shared persistent connection - nothing to release per request.
        echo json_encode(['ok' => true]);
        break;
    }

    case 'query': {
        $host = ks_str($req, 'host');
        $port = (int) ($req['port'] ?? 3306);
        $user = ks_str($req, 'user');
        $password = ks_str($req, 'password');
        $database = ks_str($req, 'database');
        $sql = ks_str($req, 'sql');
        $maxRows = (int) ($req['maxRows'] ?? 0);
        $charset = ks_str($req, 'charset', 'utf8mb4');
        if ($host === '' || $user === '' || $sql === '') {
            ks_fail(400, 'host, user and sql are required');
        }

        $conn = ks_connect($host, $port, $user, $password, $charset);
        if ($database !== '' && !@mysqli_select_db($conn, $database)) {
            ks_fail(400, mysqli_error($conn), ['errno' => mysqli_errno($conn), 'sqlState' => mysqli_sqlstate($conn)]);
        }
        if (!mysqli_multi_query($conn, $sql)) {
            ks_fail(400, mysqli_error($conn), ['errno' => mysqli_errno($conn), 'sqlState' => mysqli_sqlstate($conn)]);
        }

        $results = [];
        do {
            $result = mysqli_store_result($conn);
            if ($result === false && mysqli_errno($conn) !== 0) {
                ks_fail(400, mysqli_error($conn), ['errno' => mysqli_errno($conn), 'sqlState' => mysqli_sqlstate($conn), 'partial' => $results]);
            }
            if ($result instanceof mysqli_result) {
                $rawFields = mysqli_fetch_fields($result);
                $fields = array_map('ks_field', $rawFields);
                $binaryCols = [];
                foreach ($rawFields as $i => $f) {
                    if (ks_is_binary($f->type, $f->charsetnr)) {
                        $binaryCols[$i] = true;
                    }
                }
                $rows = [];
                $n = 0;
                $truncated = false;
                while (($row = mysqli_fetch_row($result)) !== null) {
                    if ($maxRows > 0 && $n >= $maxRows) {
                        $truncated = true;
                        break;
                    }
                    foreach ($row as $i => $v) {
                        if ($v === null) {
                            continue;
                        }
                        $row[$i] = isset($binaryCols[$i]) ? ['__b64' => base64_encode($v)] : (string) $v;
                    }
                    $rows[] = $row;
                    $n++;
                }
                mysqli_free_result($result);
                $results[] = ['kind' => 'rows', 'fields' => $fields, 'rows' => $rows, 'truncated' => $truncated];
            } else {
                $info = mysqli_info($conn) ?? '';
                $changed = null;
                if (preg_match('/Changed:\\\\s*(\\\\d+)/', $info, $m)) {
                    $changed = (int) $m[1];
                }
                $results[] = [
                    'kind' => 'ok',
                    'affectedRows' => (int) mysqli_affected_rows($conn),
                    'insertId' => (string) mysqli_insert_id($conn),
                    'changedRows' => $changed ?? (int) mysqli_affected_rows($conn),
                    'warningStatus' => mysqli_warning_count($conn),
                    'info' => $info
                ];
            }
        } while (mysqli_more_results($conn) && mysqli_next_result($conn));

        mysqli_query($conn, 'SELECT @@in_transaction');
        $inTransaction = false;
        if ($txResult = mysqli_store_result($conn)) {
            $txRow = mysqli_fetch_row($txResult);
            $inTransaction = isset($txRow[0]) && (int) $txRow[0] === 1;
            mysqli_free_result($txResult);
        }

        echo json_encode(['ok' => true, 'results' => $results, 'inTransaction' => $inTransaction]);
        break;
    }

    default:
        ks_fail(400, 'Unknown action');
}
`;
