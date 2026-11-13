<?php
declare(strict_types=1);

const TEST_PREFIX = '/anubis-bridge-test';
const PASS_PATH = '/.within.website/x/cmd/anubis/api/pass-challenge';
const NON_PASS_PATH = '/.within.website/x/cmd/anubis/api/not-pass-challenge';
const TEST_COOKIE = 'proxy-lab-cookie-verification';

$upstreamScheme = getenv('PROXY_LAB_UPSTREAM_SCHEME') ?: 'https';
$upstreamHost = getenv('PROXY_LAB_UPSTREAM_HOST') ?: 'serve.495648.xyz';
$upstreamPort = getenv('PROXY_LAB_UPSTREAM_PORT') ?: '';
$upstreamAuthority = $upstreamHost . ($upstreamPort !== '' ? ':' . $upstreamPort : '');
$upstreamOrigin = $upstreamScheme . '://' . $upstreamAuthority;
$token = require __DIR__ . '/secret.php';
$suppliedToken = $_SERVER['HTTP_X_PROXY_LAB_TOKEN'] ?? '';
if (!is_string($token) || !is_string($suppliedToken) || !hash_equals($token, $suppliedToken)) {
    http_response_code(401);
    header('Cache-Control: no-store');
    exit;
}

$uri = (string)($_SERVER['REQUEST_URI'] ?? '/');
if (strlen($uri) > 4096 || strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
    http_response_code(400);
    header('Cache-Control: no-store');
    exit;
}
$parsed = parse_url($uri);
$path = (string)($parsed['path'] ?? '/');
if (!str_starts_with($path, TEST_PREFIX . '/') && $path !== TEST_PREFIX) {
    http_response_code(404);
    exit;
}
$relativePath = substr($path, strlen(TEST_PREFIX));
$query = $_GET;
$case = (string)($query['case'] ?? $_SERVER['HTTP_X_TEST_CASE'] ?? '');
$testSession = (string)($_SERVER['HTTP_X_TEST_SESSION'] ?? '');
$requestId = (string)($_SERVER['HTTP_X_REQUEST_ID'] ?? '');
$allowedCases = [
    'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10',
    'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'C01', 'C02',
];
if (!in_array($case, $allowedCases, true)
    || !preg_match('/^[a-f0-9-]{36}$/i', $testSession)
    || !preg_match('/^[a-f0-9-]{36}$/i', $requestId)) {
    http_response_code(400);
    header('Cache-Control: no-store');
    exit;
}

if ($relativePath === '/__records') {
    $records = [];
    $file = __DIR__ . '/records.ndjson';
    if (is_file($file)) {
        $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        foreach ($lines as $line) {
            $record = json_decode($line, true);
            if (!is_array($record) || ($record['test_session'] ?? null) !== $testSession) continue;
            if (isset($query['request_id']) && ($record['request_id'] ?? null) !== $query['request_id']) continue;
            $records[] = $record;
        }
    }
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['records' => $records], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$contentType = (string)($_SERVER['CONTENT_TYPE'] ?? '');
$receivedRedir = isset($query['redir']) && is_string($query['redir']) ? $query['redir'] : null;
$cookieNames = [];
foreach (explode(';', (string)($_SERVER['HTTP_COOKIE'] ?? '')) as $cookiePart) {
    $separator = strpos($cookiePart, '=');
    if ($separator === false) continue;
    $name = trim(substr($cookiePart, 0, $separator));
    if ($name !== '' && $name !== 'mirror_sid') $cookieNames[] = $name;
}

$responseStatus = 404;
$responseLocation = null;
$responseMode = 'unsupported';
$matched = false;
$body = '';
$version = '1.28.2';

if ($relativePath === '/') {
    $responseStatus = 403;
    $responseMode = 'challenge';
    $matched = true;
    if ($case === 'R08') $version = '9.9.9';
    $body = '<!doctype html><html><head><script id="anubis_version" type="application/json">"'
        . $version . '"</script></head><body>Remote bridge fixture challenge</body></html>';
} elseif ($relativePath === PASS_PATH) {
    $matched = in_array($case, ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'C01', 'C02'], true);
    if ($case === 'L02') {
        $responseStatus = 200;
        $responseMode = 'ordinary-200';
        $body = 'remote ordinary response';
    } elseif ($case === 'L03') {
        $responseStatus = 400;
        $responseMode = 'error-400';
        $body = 'remote configured error';
    } elseif (in_array($case, ['L04', 'L05', 'L06', 'L07'], true)) {
        $responseStatus = 302;
        $responseMode = 'abnormal-location';
        $responseLocation = match ($case) {
            'L04' => 'https://evil.invalid/anubis-bridge-test/final',
            'L05' => $upstreamScheme . '://' . $upstreamHost . ':8443/anubis-bridge-test/final',
            'L06' => ($upstreamScheme === 'https' ? 'http' : 'https') . '://' . $upstreamAuthority . '/anubis-bridge-test/final',
            'L07' => $upstreamOrigin . TEST_PREFIX . '/%252F%252Fevil.invalid',
        };
    } else {
        $responseStatus = 302;
        $responseMode = 'success-302';
        $responseLocation = $upstreamOrigin . TEST_PREFIX . '/final?case=' . rawurlencode($case);
    }
} elseif ($relativePath === NON_PASS_PATH) {
    $matched = in_array($case, ['R09', 'L08'], true);
    $responseStatus = 302;
    $responseMode = 'non-pass-302';
    $responseLocation = $upstreamOrigin . TEST_PREFIX . '/final?case=' . rawurlencode($case);
} elseif ($relativePath === '/business') {
    $matched = in_array($case, ['R10', 'C01', 'C02'], true);
    $responseMode = 'ordinary-200';
    $authorized = in_array('proxy-lab-auth-deadbeef', $cookieNames, true);
    $responseStatus = $case === 'C01' || $case === 'C02' ? ($authorized ? 200 : 403) : 200;
    if ($responseStatus === 403) $responseMode = 'ordinary-403-missing-session-cookie';
    $body = $responseStatus === 200 ? 'remote business response' : 'missing session-scoped fixture cookie';
} else {
    header('Cache-Control: no-store');
    http_response_code(404);
    exit;
}

$record = [
    'timestamp' => gmdate('c'),
    'test_case' => $case,
    'test_session' => $testSession,
    'request_id' => $requestId,
    'method' => $method,
    'path' => $path,
    'query' => ['case' => $case, 'redir' => $receivedRedir],
    'redir' => $receivedRedir,
    'content_type' => $contentType,
    'cookie_names' => array_values(array_unique($cookieNames)),
    'matched_preset' => $matched,
    'response_mode' => $responseMode,
    'response_status' => $responseStatus,
    'response_location' => $responseLocation,
];
file_put_contents(
    __DIR__ . '/records.ndjson',
    json_encode($record, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR) . "\n",
    FILE_APPEND | LOCK_EX,
);

http_response_code($responseStatus);
header('Cache-Control: no-store');
if ($relativePath === '/') {
    header('Content-Type: text/html; charset=utf-8');
    header('Set-Cookie: ' . TEST_COOKIE . '=fixture; Domain=' . $upstreamHost . '; Path=/; Secure; HttpOnly; SameSite=None');
} elseif ($responseLocation !== null) {
    header('Location: ' . $responseLocation);
    header('Content-Length: 0');
} else {
    header('Content-Type: text/plain; charset=utf-8');
}
if ($relativePath === PASS_PATH && $case === 'C01' && $responseStatus === 302) {
    header('Set-Cookie: proxy-lab-auth-deadbeef=fixture-auth-value; Domain=' . $upstreamHost . '; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=3600', false);
}
if ($body !== '') echo $body;
