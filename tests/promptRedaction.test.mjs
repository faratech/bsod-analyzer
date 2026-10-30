import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { redactPersonalIdentifiers as redact, redactPersonalBytes, collectPersonalNames } from '../shared/promptRedaction.js';
import { assertScalesLinearly } from './helpers/linearTime.mjs';

// Browser WinDBG-fallback prompts carry strings read straight from the dump;
// profile folder names and email addresses are redacted before they reach the
// AI provider and the stored prompt (issue #345).

test('profile folder names are redacted in Windows paths of any form (issue #345)', () => {
  const cases = [
    ['C:\\Users\\JohnDoe\\AppData\\Local\\Temp\\x.sys', 'C:\\Users\\<user>\\AppData\\Local\\Temp\\x.sys'],
    ['c:\\USERS\\JohnDoe\\Desktop', 'c:\\USERS\\<user>\\Desktop'],
    ['D:/users/jane.doe/Documents/a.txt', 'D:/users/<user>/Documents/a.txt'],
    ['\\\\fileserver\\share$\\Users\\jdoe\\profile.dat', '\\\\fileserver\\share$\\Users\\<user>\\profile.dat'],
    ['\\Device\\HarddiskVolume3\\Users\\John Doe\\OneDrive\\f.docx', '\\Device\\HarddiskVolume3\\Users\\<user>\\OneDrive\\f.docx'],
    ['\\??\\C:\\Users\\Mixed\\x', '\\??\\C:\\Users\\<user>\\x'],
    ['C:\\Documents and Settings\\Olduser\\Local Settings', 'C:\\Documents and Settings\\<user>\\Local Settings'],
    ['C:\\Users\\JohnDoe', 'C:\\Users\\<user>'],
    // In running text the name ends at the first word that is not part of a
    // plausible display name; the rest of the line stays (issue #363).
    ['path C:\\Users\\JohnDoe then more text', 'path C:\\Users\\<user> then more text'],
    ['C:\\Users\\\\JohnDoe\\x', 'C:\\Users\\\\<user>\\x'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('UTF-16LE text decoded with embedded NULs cannot hide a profile path (issue #345)', () => {
  const utf16AsBytes = Buffer.from('C:\\Users\\JohnDoe\\NTUSER.DAT', 'utf16le').toString('latin1');
  assert.ok(utf16AsBytes.includes('\u0000'));
  assert.equal(redact(utf16AsBytes), 'C:\\Users\\<user>\\NTUSER.DAT');
  assert.equal(redact('j\u0000o\u0000h\u0000n\u0000@\u0000example.com'), '<email>');
});

test('email addresses are redacted; look-alikes from dumps are not (issue #345)', () => {
  assert.equal(redact('owner: John.Doe+bsod@mail.example.co.uk;'), 'owner: <email>;');
  assert.equal(redact('JOHN@EXAMPLE.COM'), '<email>');
  for (const keep of ['@%SystemRoot%\\system32\\drivers\\acpi.sys,-101', 'nt!KiBugCheck@0x10', 'foo.sys@1.2.3', 'user@localhost']) {
    assert.equal(redact(keep), keep, keep);
  }
});

test('driver, module and shared-profile paths stay intact so crash evidence is unchanged (issue #345)', () => {
  const keep = [
    '\\SystemRoot\\System32\\drivers\\nvlddmkm.sys',
    'C:\\Windows\\System32\\DriverStore\\FileRepository\\nv_dispi.inf_amd64_1\\nvlddmkm.sys',
    'C:\\Program Files\\NVIDIA Corporation\\x.dll',
    'C:\\Users\\Public\\Documents',
    'C:\\Users\\Default\\NTUSER.DAT',
    'C:\\Users\\All Users\\Microsoft',
    'BUGCHECK_CODE: d1 IMAGE_NAME: rtwlane.sys DESKTOP-JD1234',
    'Windows 10 Kernel Version 19041 MP (8 procs) Built by: 19041.1.amd64fre.vb_release.191206-1406',
    'MyUsers\\thing', // "Users" not a path segment
  ];
  for (const text of keep) assert.equal(redact(text), text, text);
  // Already redacted text is stable.
  const once = redact('C:\\Users\\JohnDoe\\x john@example.com');
  assert.equal(redact(once), once);
  assert.equal(redact(''), '');
  assert.equal(redact(undefined), '');
});

test('redaction scales linearly on large adversarial input (issue #345)', () => {
  const builders = [
    n => 'a'.repeat(20_000 * n),
    n => '\\Users\\'.repeat(5_000 * n),
    n => ('\\Users\\' + 'x'.repeat(63)).repeat(500 * n),
    n => ('a'.repeat(64) + '@').repeat(500 * n),
    n => ('a@b.' + 'c-'.repeat(30)).repeat(300 * n),
    n => 'x@' + 'a.'.repeat(10_000 * n),
    n => 'USERNAME=aaa aaa aaa\n' + 'aaa '.repeat(5_000 * n),
    n => ('USERNAME=' + 'b'.repeat(40) + '\n').repeat(400 * n),
    n => '\\Users\\' + 'a b'.repeat(5_000 * n),
  ];
  for (const [i, make] of builders.entries()) {
    assertScalesLinearly(`builder ${i}`, redact, make);
  }
});

test('profile names with spaces, past 64 chars or at the end of a line are redacted whole (issue #360)', () => {
  const cases = [
    ['USERPROFILE=C:\\Users\\John Smith', 'USERPROFILE=C:\\Users\\<user>'],
    ['HOMEPATH=\\Users\\John Smith\nnext', 'HOMEPATH=\\Users\\<user>\nnext'],
    ['C:\\Users\\' + 'a'.repeat(70) + '\\AppData', 'C:\\Users\\<user>\\AppData'],
    ['C:\\Users\\' + 'a b'.repeat(30) + '\\AppData', 'C:\\Users\\<user>\\AppData'],
    ['C:\\Users\\JOHNDO~1\\AppData\\Local\\Temp', 'C:\\Users\\<user>\\AppData\\Local\\Temp'],
    // A path on its own: the name runs to the end, minus the trailing dots
    // and spaces Windows strips from folder names (issue #363).
    ['C:\\Users\\bob smith.', 'C:\\Users\\<user>.'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('identifying environment values are redacted and the key kept (issue #360)', () => {
  const cases = [
    ['USERNAME=jsmith', 'USERNAME=<user>'],
    ['USERNAME=John Smith', 'USERNAME=<user>'],
    ['COMPUTERNAME=DESKTOP-JD1234', 'COMPUTERNAME=<host>'],
    ['USERDOMAIN=CONTOSO', 'USERDOMAIN=<host>'],
    ['USERDOMAIN_ROAMINGPROFILE=CONTOSO', 'USERDOMAIN_ROAMINGPROFILE=<host>'],
    ['USERDNSDOMAIN=corp.contoso.com', 'USERDNSDOMAIN=<host>'],
    ['LOGONSERVER=\\\\DC01', 'LOGONSERVER=\\\\<host>'],
    ['CLIENTNAME=JOHNS-LAPTOP', 'CLIENTNAME=<host>'],
    ['USERPROFILE=D:\\Profiles\\jsmith', 'USERPROFILE=D:\\Profiles\\<user>'],
    ['HOMESHARE=\\\\fs01\\home$\\jsmith', 'HOMESHARE=\\\\fs01\\home$\\<user>'],
    ['username=jsmith', 'username=<user>'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  // Non-personal values and look-alike keys stay readable.
  const keep = [
    'USERNAME=SYSTEM', 'USERNAME=Administrator', 'USERNAME=LOCAL SERVICE', 'USERNAME=NETWORK SERVICE',
    'USERNAME=DefaultAccount', 'USERNAME=Guest', 'USERDOMAIN=WORKGROUP', 'USERDOMAIN=NT AUTHORITY',
    'USERDOMAIN=AzureAD', 'MYUSERNAME_X=1', 'C:\\Users\\Administrator\\x', 'C:\\Users\\Public\\x',
    'C:\\Users\\Default User\\x', 'C:\\Users\\All Users\\x', 'HOMEPATH=\\', 'PROCESSOR_IDENTIFIER=Intel64 Family 6',
    'ALLUSERSPROFILE=C:\\ProgramData',
  ];
  for (const text of keep) assert.equal(redact(text), text, text);
});

test('a user or computer name found once is redacted everywhere in the evidence (issue #360)', () => {
  const evidence = [
    'USERNAME=jsmith',
    'COMPUTERNAME=DESKTOP-JD1234',
    'C:\\Users\\mary.jones\\Desktop',
    'jsmith-PC; owner JSmith; \\\\DESKTOP-JD1234\\c$; mary.jones wrote it',
    'jsmithers and xjsmith are other words; nvlddmkm.sys stays',
  ].join('\n');
  assert.equal(redact(evidence), [
    'USERNAME=<user>',
    'COMPUTERNAME=<host>',
    'C:\\Users\\<user>\\Desktop',
    '<user>-PC; owner <user>; \\\\<host>\\c$; <user> wrote it',
    'jsmithers and xjsmith are other words; nvlddmkm.sys stays',
  ].join('\n'));
  // Short or non-personal names are not hunted elsewhere.
  assert.equal(redact('USERNAME=al\nal dente; also Administrator'), 'USERNAME=<user>\nal dente; also Administrator');
  assert.equal(redact('C:\\Users\\Owner\\x Owner'), 'C:\\Users\\Owner\\x Owner');
});

test('redaction is idempotent across every rule (issues #345, #360)', () => {
  const inputs = [
    'USERNAME=user\nC:\\Users\\user\\x user',
    'USERPROFILE=C:\\Users\\John Smith\nJohn Smith john@example.com',
    'COMPUTERNAME=host\nhost <host>',
    'LOGONSERVER=\\\\DC01\nDC01',
  ];
  for (const input of inputs) {
    const once = redact(input);
    assert.equal(redact(once), once, input);
  }
});

test('the finder\'s 1 MB adversarial inputs each redact within a second (issue #360)', () => {
  const N = 1e6;
  const inputs = {
    users: 'C:\\Users\\'.repeat(N / 9),
    usersNoSep: '\\Users\\' + 'a'.repeat(N),
    at: '@'.repeat(N),
    emailish: ('a'.repeat(60) + '@').repeat(N / 61),
    domainish: 'a@' + 'b.'.repeat(N / 2),
    nul: '\u0000'.repeat(N),
    bs: '\\'.repeat(N),
    usersSpaces: ('\\users\\' + ' '.repeat(63)).repeat(N / 71),
    env: ('USERNAME=' + 'a'.repeat(50) + '\n').repeat(N / 60),
    envKeys: 'USERNAME='.repeat(N / 9),
    names: 'USERNAME=aaa aaa aaa aaa aaa aaa aaa aaa\n' + 'aaa '.repeat(N / 4),
    manyNames: Array.from({ length: 2000 }, (_, i) => `USERNAME=name${i}x`).join('\n') + '\n' + 'name1x '.repeat(N / 7),
  };
  for (const [label, input] of Object.entries(inputs)) {
    const started = performance.now();
    redact(input);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${label}: ${ms.toFixed(0)} ms`);
  }
});

// Byte excerpts are hex-dumped into the fallback prompt, where neither a
// UTF-16 path (C.:.\\.U.s.e.r.s.) nor one split across 16-byte lines can be
// matched as text, so they are redacted as bytes first (issue #359).
const latin1 = bytes => Buffer.from(bytes).toString('latin1');
const utf16At = (bytes, offset) => Buffer.from(bytes.subarray(offset, offset + ((bytes.length - offset) & ~1))).toString('utf16le');
function bytesWith(size, placements, fill = 0xcc) {
  const bytes = new Uint8Array(size).fill(fill);
  for (const [offset, text, encoding] of placements) bytes.set(Buffer.from(text, encoding), offset);
  return bytes;
}

test('profile names, env values and emails are masked as bytes in ASCII and UTF-16LE at either alignment (issue #359)', () => {
  const input = bytesWith(1024, [
    [16, 'C:\\Users\\jsmith\\AppData\\x.dll\0', 'utf16le'],
    [141, 'C:\\Users\\John Smith\\Desktop\\a.txt\0', 'utf16le'], // odd offset
    [260, 'C:\\Users\\jsmith\\Desktop\\a.txt\0', 'latin1'],
    [320, 'USERNAME=mjones\0COMPUTERNAME=DESKTOP-JD1234\0', 'utf16le'],
    [480, 'mail john.doe@example.com\0', 'latin1'],
    [560, 'later mjones and DESKTOP-JD1234 again\0', 'latin1'],
    [640, '\\SystemRoot\\System32\\drivers\\nvlddmkm.sys\0', 'utf16le'],
    [760, 'C:\\Users\\Public\\x\0', 'latin1'],
  ]);
  const before = input.slice();
  const out = redactPersonalBytes(input);
  assert.deepEqual(input, before, 'the input (used for parsing and hashing) is never modified');
  assert.equal(out.length, input.length, 'length and offsets are unchanged');
  const views = [latin1(out), utf16At(out, 0), utf16At(out, 1)].join('\n');
  for (const secret of ['jsmith', 'John Smith', 'mjones', 'DESKTOP-JD1234', 'john.doe', 'example.com']) {
    assert.ok(!views.includes(secret), `${secret} survives`);
  }
  assert.ok(utf16At(out, 0).includes('C:\\Users\\******\\AppData\\x.dll'), 'UTF-16 name masked in place');
  assert.ok(utf16At(out, 1).includes('C:\\Users\\**********\\Desktop'), 'odd-aligned UTF-16 name masked');
  assert.ok(latin1(out).includes('C:\\Users\\******\\Desktop\\a.txt'), 'ASCII name masked in place');
  assert.ok(utf16At(out, 0).includes('USERNAME=******'));
  assert.ok(latin1(out).includes('later ****** and ************** again'));
  assert.ok(utf16At(out, 0).includes('\\SystemRoot\\System32\\drivers\\nvlddmkm.sys'), 'driver paths untouched');
  assert.ok(latin1(out).includes('C:\\Users\\Public\\x'), 'shared profiles untouched');
  // Every changed byte is the filler (or the zero half of a UTF-16 filler).
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== input[i]) assert.ok(out[i] === 0x2a || out[i] === 0x00, `byte ${i}`);
  }
  // Bytes with nothing personal come back identical.
  const plain = bytesWith(512, [[8, 'BUGCHECK nvlddmkm.sys C:\\Windows\\System32\\ntoskrnl.exe', 'latin1']]);
  assert.deepEqual(redactPersonalBytes(plain), plain);
});

test('byte redaction hunts names found elsewhere in the dump and masks a cut-off leading string (issue #359)', () => {
  const names = collectPersonalNames('USERPROFILE=C:\\Users\\alice.w\nCOMPUTERNAME=ALICE-PC');
  const input = bytesWith(256, [[0, 'ith\\AppData\\Local', 'latin1'], [64, 'owner alice.w on ALICE-PC', 'utf16le']]);
  const plainOut = redactPersonalBytes(input, { names });
  assert.ok(!utf16At(plainOut, 0).includes('alice.w') && !utf16At(plainOut, 0).includes('ALICE-PC'));
  assert.ok(latin1(plainOut).startsWith('ith\\AppData'), 'without maskLeadingRun the head is kept');
  const edgeOut = redactPersonalBytes(input, { names, maskLeadingRun: true });
  assert.ok(latin1(edgeOut).startsWith('*****************'), latin1(edgeOut).slice(0, 20));
});

test('byte redaction is linear and handles 16 MB buffers (issue #359)', () => {
  const big = new Uint8Array(16 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
  big.set(Buffer.from('C:\\Users\\jsmith\\x', 'utf16le'), 8 * 1024 * 1024 + 1);
  const started = performance.now();
  const out = redactPersonalBytes(big);
  const ms = performance.now() - started;
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
  assert.ok(!utf16At(out, 1).includes('jsmith'));
  assertScalesLinearly('bytes', redactPersonalBytes, n => {
    const bytes = new Uint8Array(64 * 1024 * n);
    const unit = Buffer.from('\\Users\\a@b.' + 'c'.repeat(40), 'utf16le');
    for (let i = 0; i + unit.length <= bytes.length; i += unit.length) bytes.set(unit, i);
    return bytes;
  });
});

test('both browser fallback prompt builders redact the evidence before it is sent (issue #345)', async () => {
  const source = await fs.readFile(new URL('../services/geminiProxy.ts', import.meta.url), 'utf8');
  const wraps = source.match(/wrapWithEvidence\(LOCAL_DUMP_PREFIX, [^)]*\)/g) || [];
  assert.equal(wraps.length, 2, 'the full local and the large-dump failover builders');
  for (const call of wraps) assert.match(call, /redactPersonalIdentifiers\(evidence[,)]/, call);
  // Every hex excerpt goes through the byte redaction (issue #359): the only
  // direct generateHexDump call is the one inside generateRedactedHexDump.
  const direct = source.match(/generateHexDump\(/g) || [];
  assert.equal(direct.length, 2, 'the definition and the call in generateRedactedHexDump');
  assert.equal((source.match(/generateRedactedHexDump\(/g) || []).length, 4, 'definition + file head + stack + large-dump sample');
});

// Issue #362: the LocalSystem environment (HOMEPATH=\Windows\system32) made
// "system32" a hunted user name, so every System32 in driver paths became
// <user>. Path-valued environment strings name a user only when the path is
// profile-folder shaped, and Windows directory names are never names.
test('system and service environment values name nobody, and System32 stays in driver paths (issue #362)', async () => {
  const { NON_PERSONAL_NAMES } = await import('../shared/promptRedaction.js');
  for (const name of ['system32', 'syswow64', 'windows', 'winnt', 'drivers', 'program files', 'program files (x86)',
    'programdata', 'appdata', 'local', 'locallow', 'roaming', 'temp', 'tmp', 'users', 'default user', 'systemroot',
    'systemprofile', 'localservice', 'networkservice', 'serviceprofiles', 'config']) {
    assert.ok(NON_PERSONAL_NAMES.has(name), name);
  }
  const systemEnv = [
    'HOMEDRIVE=C:',
    'HOMEPATH=\\Windows\\system32',
    'USERPROFILE=C:\\Windows\\system32\\config\\systemprofile',
    'USERPROFILE=C:\\WINDOWS\\ServiceProfiles\\LocalService',
    'USERPROFILE=C:\\Windows\\ServiceProfiles\\NetworkService',
    'HOMEPATH=\\Windows',
    'HOMEPATH=\\',
    'APPDATA=C:\\Windows\\system32\\config\\systemprofile\\AppData\\Roaming',
    'TEMP=C:\\WINDOWS\\TEMP',
    'USERNAME=SYSTEM',
    'USERDOMAIN=NT AUTHORITY',
    'NT AUTHORITY\\SYSTEM',
    '\\SystemRoot\\System32\\drivers\\nvlddmkm.sys',
    'C:\\Windows\\System32\\ntoskrnl.exe',
    'C:\\Windows\\SysWOW64\\ntdll.dll',
  ].join('\n');
  assert.deepEqual([...collectPersonalNames(systemEnv).keys()], []);
  assert.equal(redact(systemEnv), systemEnv);
  const bytes = bytesWith(systemEnv.length * 2 + 8, [[0, systemEnv + "\0", "utf16le"]]);
  assert.deepEqual(redactPersonalBytes(bytes), bytes);
  // Profile-shaped values still name the user.
  for (const [input, expected] of [
    ['HOMEPATH=\\Users\\jsmith', 'HOMEPATH=\\Users\\<user>'],
    ['USERPROFILE=D:\\Profiles\\jsmith', 'USERPROFILE=D:\\Profiles\\<user>'],
    ['HOMESHARE=\\\\fs01\\home$\\jsmith', 'HOMESHARE=\\\\fs01\\home$\\<user>'],
  ]) assert.equal(redact(input), expected, input);
});

// Realistic crash text with nothing personal in it must come back unchanged:
// redaction never touches driver, module or system paths, symbols, stop codes
// or WinDBG output (issue #362).
test('redaction is the identity on crash evidence without personal identifiers (issue #362)', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/windbgJobResultD1.json', import.meta.url), 'utf8'));
  const corpus = [
    fixture.stdout,
    ...Object.values(fixture.sections),
    '\\SystemRoot\\System32\\drivers\\nvlddmkm.sys',
    '\\SystemRoot\\system32\\DRIVERS\\rtwlane.sys',
    'C:\\Windows\\System32\\ntoskrnl.exe',
    'C:\\WINDOWS\\system32\\win32kfull.sys',
    '\\Device\\HarddiskVolume3\\Windows\\System32\\svchost.exe',
    '\\Device\\HarddiskVolume3\\Program Files\\NVIDIA Corporation\\NvContainer\\nvcontainer.exe',
    'C:\\Program Files (x86)\\Steam\\steam.exe',
    'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.24090.11-0\\MsMpEng.exe',
    'C:\\Windows\\System32\\DriverStore\\FileRepository\\nv_dispi.inf_amd64_1\\nvlddmkm.sys',
    '\\??\\C:\\Windows\\system32\\drivers\\Wdf01000.sys',
    'C:\\Windows\\WinSxS\\amd64_microsoft-windows-kernel_31bf3856ad364e35\\ntoskrnl.exe',
    'C:\\Users\\Public\\Documents\\x.log',
    'C:\\Users\\Default\\NTUSER.DAT',
    'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\Temp\\x.tmp',
    'nt!KiSwapContext+0x76',
    'nt!KeBugCheckEx',
    'nvlddmkm+0x1a2b3c',
    'fffff803`6b000000 fffff803`6c000000   nvlddmkm   (deferred)',
    'DRIVER_IRQL_NOT_LESS_OR_EQUAL (d1)',
    'SYSTEM_SERVICE_EXCEPTION (3b)',
    '*** STOP: 0x0000003B (0x00000000C0000005,0xFFFFF80012345678,0xFFFFD0012345E930,0x0000000000000000)',
    'BUGCHECK_CODE:  d1',
    'PROCESS_NAME:  System',
    'IMAGE_NAME:  nvlddmkm.sys',
    'FAILURE_BUCKET_ID:  AV_nvlddmkm!unknown_function',
    'Windows 10 Kernel Version 19041 MP (8 procs) Free x64',
    'Built by: 19041.1.amd64fre.vb_release.191206-1406',
    'Product: WinNt, suite: TerminalServer SingleUserTS',
    'HOMEDRIVE=C:\nHOMEPATH=\\Windows\\system32\nUSERNAME=SYSTEM\nUSERDOMAIN=WORKGROUP',
    'ComSpec=C:\\WINDOWS\\system32\\cmd.exe',
    'PATH=C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\WINDOWS\\System32\\Wbem',
    'windir=C:\\WINDOWS\nSystemRoot=C:\\WINDOWS\nALLUSERSPROFILE=C:\\ProgramData',
    '@%SystemRoot%\\system32\\drivers\\acpi.sys,-101',
    'https://go.microsoft.com/fwlink/?LinkId=123',
  ];
  const text = corpus.join('\n');
  assert.equal(redact(text), text);
  for (const line of corpus) assert.equal(redact(line), line, line);
  for (const encoding of ['latin1', 'utf16le']) {
    const bytes = bytesWith(text.length * 2 + 16, [[1, text, encoding]]);
    assert.deepEqual(redactPersonalBytes(bytes), bytes, encoding);
  }
});

// Issue #363: since #360 a profile name without a separator after it ran to
// the end of the line, so in running text it swallowed the rest of the line
// and the harvested "name" was a sentence that never recurs. A path standing
// on its own (or as a KEY=value) may still end the line with a multi-word
// name; in running text the name is conservative and its first word is
// hunted on its own.
test('a profile path in running text never swallows the rest of the line (issue #363)', () => {
  const cases = [
    ['Opened C:\\Users\\John, then loaded nvlddmkm.sys at 0xFFFFF80012340000',
      'Opened C:\\Users\\<user>, then loaded nvlddmkm.sys at 0xFFFFF80012340000'],
    ['cmd.exe /c cd C:\\Users\\jsmith && start nvlddmkm-helper.exe 0xC0000005\nmapped by jsmith',
      'cmd.exe /c cd C:\\Users\\<user> && start nvlddmkm-helper.exe 0xC0000005\nmapped by <user>'],
    ['see \\Users\\jsmith and \\Windows\\x', 'see \\Users\\<user> and \\Windows\\x'],
    ['found \\Users\\jsmith then C:\\x.sys', 'found \\Users\\<user> then C:\\x.sys'],
    ['logged C:\\Users\\John Smith (console), John and Smith', 'logged C:\\Users\\<user> (console), <user> and Smith'],
    ['copy "C:\\Users\\Mary Ann Lee" D:\\x', 'copy "C:\\Users\\<user>" D:\\x'],
    ['load C:\\Users\\jsmith\'s files', 'load C:\\Users\\<user>\'s files'],
    ['C:\\Users\\jsmith: access denied', 'C:\\Users\\<user>: access denied'],
    ['"C:\\Users\\John Smith" -k', '"C:\\Users\\<user>" -k'],
    // Path-shaped lines and KEY=value strings keep the #360 behaviour.
    ['USERPROFILE=C:\\Users\\John Smith', 'USERPROFILE=C:\\Users\\<user>'],
    ['OneDrive=C:\\Users\\john smith', 'OneDrive=C:\\Users\\<user>'],
    ['\\Device\\HarddiskVolume3\\Users\\john smith', '\\Device\\HarddiskVolume3\\Users\\<user>'],
    ['C:\\Users\\' + 'a'.repeat(70), 'C:\\Users\\<user>'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  assert.deepEqual([...collectPersonalNames('Opened C:\\Users\\John, then loaded nvlddmkm.sys at 0xFFFFF80012340000').keys()], ['john']);
  assert.deepEqual([...collectPersonalNames('logged C:\\Users\\John Smith (console)').keys()].sort(), ['john', 'john smith']);
  // A segment that cannot be an account name is not taken whole.
  assert.deepEqual([...collectPersonalNames('C:\\Users\\jsmith,backup\\x').keys()], ['jsmith']);
});

// Issue #364: the first 32 harvested names won, and URL paths with a /users/
// segment were harvested, so a few dozen URLs before the (usually UTF-16)
// profile path kept the real name from ever being hunted.
test('URL paths are neither redacted nor harvested; Windows forward-slash paths are (issue #364)', () => {
  const urls = [
    'https://api.example.com/users/u1000',
    'https://discord.com/api/v9/users/@me',
    'https://github.com/users/octocat/projects',
    'http://localhost:8080/Users/jsmith/profile',
    'api.example.com/users/u1001/settings',
  ];
  for (const url of urls) {
    assert.equal(redact(url), url, url);
    assert.deepEqual([...collectPersonalNames(url).keys()], [], url);
  }
  assert.equal(redact('D:/users/jane.doe/Documents/a.txt'), 'D:/users/<user>/Documents/a.txt');
  assert.equal(redact('file:///C:/Users/jsmith/x.txt'), 'file:///C:/Users/<user>/x.txt');
});

// Issue #376: #364 required a drive letter before a forward-slash "/users/",
// so WSL, Git Bash/MSYS and macOS-style profile paths leaked again.
test('forward-slash profile paths without a drive letter are profile paths, not URLs (issue #376)', () => {
  const cases = [
    ['cd /mnt/c/Users/jsmith/projects\nowner jsmith', 'cd /mnt/c/Users/<user>/projects\nowner <user>'],
    ['/c/Users/jsmith/.bashrc', '/c/Users/<user>/.bashrc'],
    ['HOME=/Users/jsmith/Library x', 'HOME=/Users/<user>/Library x'],
    ['source "/c/Users/jsmith/.profile"', 'source "/c/Users/<user>/.profile"'],
    ['PATH:/mnt/d/users/jsmith/bin', 'PATH:/mnt/d/users/<user>/bin'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redact(input), expected, input);
    assert.deepEqual([...collectPersonalNames(input).keys()], ['jsmith'], input);
  }
  // The hex views (issue #359) take the same rule: Latin-1 and UTF-16LE.
  for (const encoding of ['latin1', 'utf16le']) {
    const bytes = Buffer.from('xx/mnt/c/Users/jsmith/p\0seen by jsmith\0', encoding);
    const out = Buffer.from(redactPersonalBytes(new Uint8Array(bytes))).toString(encoding);
    assert.equal(out, 'xx/mnt/c/Users/******/p\0seen by ******\0', encoding);
  }
  // URLs stay untouched and harvest nothing (#364), whatever the scheme.
  for (const url of [
    'https://api.example.com/users/u1000',
    'discord.com/api/v9/users/@me',
    'see https://discord.com/api/v9/users/123456/profile',
    'ws://10.0.0.5:9000/users/u42/feed',
    'localhost:3000/users/jsmith',
    '/api/v1/users/u77/settings',
  ]) {
    assert.equal(redact(url), url, url);
    assert.deepEqual([...collectPersonalNames(url).keys()], [], url);
  }
  // file: URLs are local paths.
  assert.equal(redact('file:///Users/jsmith/x.txt'), 'file:///Users/<user>/x.txt');
  // URL spam before a WSL path does not keep its name from being hunted.
  const urls = Array.from({ length: 200 }, (_, i) => `https://api.example.com/users/u${1000 + i}`);
  assert.match(redact([...urls, '/mnt/c/Users/jsmith/x', 'mapped by jsmith'].join('\n')), /\/mnt\/c\/Users\/<user>\/x\nmapped by <user>$/);
  // The URL test reads each token once, however many /users/ it holds.
  assertScalesLinearly('chained /users/', redact, n => '/users/ab'.repeat(20_000 * n));
  assertScalesLinearly('long URL path', redact, n => 'https://x.com' + '/v1/users/ab'.repeat(20_000 * n));
});

// Issue #377: the hunted-name keys were lowercased as whole strings (final
// sigma, İ -> i + U+0307) but the text one code unit at a time, so they never
// met for those characters.
test('hunted names match whatever their case mapping (Greek final sigma, Turkish İ/ı, German ß) (issue #377)', () => {
  const cases = [
    ['USERNAME=ΟΔΥΣΣΕΥΣ\nhello ΟΔΥΣΣΕΥΣ and Οδυσσευς and οδυσσευς', 'USERNAME=<user>\nhello <user> and <user> and <user>'],
    ['USERNAME=Οδυσσευς\nhello ΟΔΥΣΣΕΥΣ', 'USERNAME=<user>\nhello <user>'],
    ['C:\\Users\\İbrahim\\AppData\\x\nowner İbrahim, İBRAHIM', 'C:\\Users\\<user>\\AppData\\x\nowner <user>, <user>'],
    ['C:\\Users\\ılgın\\x\nby ILGIN and Ilgın', 'C:\\Users\\<user>\\x\nby <user> and <user>'],
    ['C:\\Users\\Weiß\\x\nby WEIß and weiß and WEIẞ', 'C:\\Users\\<user>\\x\nby <user> and <user> and <user>'],
    ['USERNAME=JoHn.SmItH\nfrom john.smith and JOHN.SMITH', 'USERNAME=<user>\nfrom <user> and <user>'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  // The same names hunted from collected names into another text (and bytes).
  const names = collectPersonalNames('C:\\Users\\İbrahim\\x');
  assert.equal(redact('signed İbrahim', { names }), 'signed <user>');
  const bytes = Buffer.from('USERNAME=ΟΔΥΣΣΕΥΣ\0by Οδυσσευς\0', 'utf16le');
  assert.equal(Buffer.from(redactPersonalBytes(new Uint8Array(bytes))).toString('utf16le'), 'USERNAME=********\0by ********\0');
});

// Issue #381: OEM and shop-built PCs ship with vendor-named accounts; hunting
// "Dell" everywhere erased the BIOS vendor and system model.
test('vendor-named profiles are masked in their paths and env values but not hunted as bare words (issue #381)', async () => {
  const { VENDOR_NAMES } = await import('../shared/promptRedaction.js');
  for (const vendor of ['dell', 'asus', 'acer', 'lenovo', 'msi', 'samsung', 'toshiba', 'gigabyte', 'razer', 'alienware', 'intel', 'amd', 'nvidia', 'realtek']) {
    assert.ok(VENDOR_NAMES.has(vendor), vendor);
  }
  assert.equal(
    redact('C:\\Users\\Dell\\AppData\\x.dll\nBIOS Vendor: Dell Inc.\nSystem: Dell G15 5515'),
    'C:\\Users\\<user>\\AppData\\x.dll\nBIOS Vendor: Dell Inc.\nSystem: Dell G15 5515'
  );
  assert.equal(
    redact('USERNAME=NVIDIA\nUSERPROFILE=C:\\Users\\ASUS\nnvlddmkm.sys NVIDIA Corporation, ASUSTeK ASUS ROG'),
    'USERNAME=<user>\nUSERPROFILE=C:\\Users\\<user>\nnvlddmkm.sys NVIDIA Corporation, ASUSTeK ASUS ROG'
  );
  // A vendor word inside a longer name keeps the longer name hunted.
  assert.equal(redact('C:\\Users\\Dell User\\x\nowner Dell User; Dell Inc.'), 'C:\\Users\\<user>\\x\nowner <user>; Dell Inc.');
  // Other names are still hunted; and so are the bytes of the hex views.
  assert.equal(redact('C:\\Users\\jsmith\\x\nby jsmith'), 'C:\\Users\\<user>\\x\nby <user>');
  const bytes = Buffer.from('C:\\Users\\Lenovo\\x\0Lenovo ThinkPad\0', 'utf16le');
  assert.equal(Buffer.from(redactPersonalBytes(new Uint8Array(bytes))).toString('utf16le'), 'C:\\Users\\******\\x\0Lenovo ThinkPad\0');
});

test('hunted names are ranked so junk cannot crowd out the real name, and capped (issue #364)', async () => {
  const { MAX_HUNTED_NAMES } = await import('../shared/promptRedaction.js');
  assert.ok(MAX_HUNTED_NAMES >= 128, String(MAX_HUNTED_NAMES));
  // 32 URLs first (as extractPrintableStrings lists ASCII before UTF-16).
  const urls = Array.from({ length: 32 }, (_, i) => `https://api.example.com/users/u${1000 + i}`);
  const text = [...urls, 'C:\\Users\\jsmith\\AppData\\x.dll', 'owner: jsmith'].join('\n');
  assert.equal(redact(text), [...urls, 'C:\\Users\\<user>\\AppData\\x.dll', 'owner: <user>'].join('\n'));
  // Hundreds of host names first: profile-path names still rank first.
  const hosts = Array.from({ length: 300 }, (_, i) => `CLIENTNAME=HOST${i}X`).join('\n');
  assert.match(redact(`${hosts}\nC:\\Users\\jsmith\\x\nmapped by jsmith`), /mapped by <user>$/);
  // More profile names than the cap: the most frequent win, then first seen;
  // names past the cap are masked in their paths only.
  const many = Array.from({ length: MAX_HUNTED_NAMES + 72 }, (_, i) => `C:\\Users\\person${i}x\\a`);
  const names = collectPersonalNames([...many, 'C:\\Users\\lastone\\a', 'C:\\Users\\lastone\\b'].join('\n'));
  const out = redact(['person0x', `person${MAX_HUNTED_NAMES - 2}x`, `person${MAX_HUNTED_NAMES + 50}x`, 'lastone'].join(' '), { names });
  assert.equal(out, `<user> <user> person${MAX_HUNTED_NAMES + 50}x <user>`);
});

test('name hunting stays linear with many long, overlapping names (issue #364)', () => {
  const names = Array.from({ length: 500 }, (_, i) => `USERNAME=${'a '.repeat(30)}${i}`).join('\n');
  assertScalesLinearly('many names', redact, n => names + '\n' + 'a '.repeat(20_000 * n));
  const started = performance.now();
  redact(names + '\n' + 'a '.repeat(500_000));
  const ms = performance.now() - started;
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

// Issue #365: names with non-ASCII characters. The prompt's strings are cut at
// the first non-ASCII character, so the names handed to the text redactor
// come from the dump bytes, and their ASCII fragments are hunted; two-letter
// names in scripts like Chinese or Japanese are hunted with a script-aware
// word boundary.
test('names are collected from dump bytes, with ASCII fragments of non-ASCII names hunted (issue #365)', async () => {
  const { collectPersonalNamesFromBytes } = await import('../shared/promptRedaction.js');
  const bytes = bytesWith(1024, [
    [16, 'C:\\Users\\Zoë Thompson\\Documents\\report.docx\0', 'utf16le'],
    [301, 'C:\\Users\\Jürgen\\AppData\\Local\\Temp\0', 'latin1'],
    [401, 'USERNAME=田中\0', 'utf16le'],
  ]);
  const names = collectPersonalNamesFromBytes(bytes);
  for (const key of ['zoë thompson', 'thompson', 'jürgen', 'rgen', '田中']) assert.ok(names.has(key), key);
  // What extractPrintableStrings leaves of those strings (cut at non-ASCII).
  const cut = ['C:\\Users\\Zo', ' Thompson\\Documents\\report.docx', 'C:\\Users\\J', 'rgen\\AppData\\Local\\Temp', 'USERNAME='].join('\n');
  assert.equal(redact(cut, { names }), ['C:\\Users\\<user>', ' <user>\\Documents\\report.docx', 'C:\\Users\\<user>', '<user>\\AppData\\Local\\Temp', 'USERNAME='].join('\n'));
  assert.equal(redact('C:\\Users\\Zoë Thompson\\x and Zoë Thompson', { names }), 'C:\\Users\\<user>\\x and <user>');
});

test('two-character CJK names are hunted with a script-aware boundary; short Latin names are not (issue #365)', () => {
  const names = collectPersonalNames('C:\\Users\\田中\\Desktop\nC:\\Users\\Bo\\x');
  assert.ok(names.has('田中'));
  assert.ok(!names.has('bo'), 'two-letter Latin names would hit ordinary words');
  assert.equal(redact('Owner 田中 PC; 田中さん; 山田中学; Bo laptop', { names }), 'Owner <user> PC; <user>さん; 山田中学; Bo laptop');
  const bytes = bytesWith(256, [[0, 'C:\\Users\\田中\\Desktop\0', 'utf16le'], [64, 'Owner 田中 PC\0', 'utf16le']]);
  const out = Buffer.from(redactPersonalBytes(bytes)).toString('utf16le');
  assert.ok(!out.includes('田中'), out);
  assert.ok(out.includes('Owner ** PC'), out);
  // Latin names keep the old boundary: no match inside a longer word.
  const latin = collectPersonalNames('USERNAME=Jürgen');
  assert.equal(redact('Jürgen, XJürgen, Jürgens', { names: latin }), '<user>, XJürgen, Jürgens');
});

// Issue #367: mutants of the redaction that leaked while the suite stayed
// green, and the email scan's 64-char backtracking window.
test('the longest hunted name wins at a position, so a surname never survives (issue #367)', () => {
  const names = collectPersonalNames('USERPROFILE=C:\\Users\\John Smith\nUSERNAME=john');
  assert.ok(names.has('john') && names.has('john smith'));
  assert.equal(redact('logged on: John Smith (console); John; Smithers', { names }), 'logged on: <user> (console); <user>; Smithers');
  assert.equal(redact('USERNAME=john\nUSERPROFILE=C:\\Users\\John Smith\nlogged on: John Smith'), 'USERNAME=<user>\nUSERPROFILE=C:\\Users\\<user>\nlogged on: <user>');
});

test('masked UTF-16 characters beyond Latin-1 lose their high byte too (issue #367)', () => {
  const input = bytesWith(64, [[4, 'USERNAME=Łukasz\0', 'utf16le']]);
  const out = redactPersonalBytes(input);
  const at = 4 + 'USERNAME='.length * 2;
  assert.equal(Buffer.from(out.subarray(at, at + 12)).toString('hex'), '2a002a002a002a002a002a00');
  assert.ok(!Buffer.from(out).toString('utf16le').includes('Ł'));
});

test('email addresses are found by a linear scan anchored on @ (issue #367)', () => {
  const cases = [
    ['a@b.com.x1', '<email>.x1'],
    ['x'.repeat(70) + '@example.com', 'x'.repeat(6) + '<email>'],
    ['a@b@c.com', 'a@<email>'],
    ['john@example.com_x', 'john@example.com_x'],
    ['john@example.c', 'john@example.c'],
    ['john@' + 'a'.repeat(64) + '.com', 'john@' + 'a'.repeat(64) + '.com'],
    ['mail: john@sub.' + 'b'.repeat(63) + '.org.', 'mail: <email>.'],
    ['j@a.b.c.d.e.f.g.h.i.com', '<email>'],
    ['first@one.com,second@two.org', '<email>,<email>'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  // 16 MB of 63-letter runs ending in '@' (finder: 6.5 s with the regex).
  const unit = 'a'.repeat(63) + '@';
  const text = unit.repeat((16 << 20) / unit.length);
  const started = performance.now();
  redact(text);
  const ms = performance.now() - started;
  assert.ok(ms < 2500, `${ms.toFixed(0)} ms`);
  assertScalesLinearly('email runs', redact, n => ('a'.repeat(1000) + '@').repeat(200 * n));
});

test('the email scan finds exactly what the former email regex found (issue #367)', () => {
  // The regex the scan replaced, as the reference.
  const reference = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;
  const alphabet = ['a', 'B', 'co', '1', '.', '-', '_', '%', '@', '@', ' ', 'x'.repeat(30), 'y'.repeat(70)];
  let seed = 12345;
  const random = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  for (let i = 0; i < 20_000; i++) {
    let s = '';
    for (let len = random(24); len > 0; len--) s += alphabet[random(alphabet.length)];
    assert.equal(redact(s), s.replace(reference, '<email>'), JSON.stringify(s));
  }
});

// Issue #382: no test hunted a name longer than 16 characters, so capping the
// trie walk below MAX_HUNTED_NAME (64) went unnoticed.
test('names up to 64 characters are hunted whole; longer ones are masked only where found (issue #382)', () => {
  assert.equal(
    redact('USERPROFILE=C:\\Users\\Christopher Johnson\nsigned by Christopher Johnson.'),
    'USERPROFILE=C:\\Users\\<user>\nsigned by <user>.'
  );
  const long = 'Maximilian-Alexander Wolfgang Bartholomew von Hohenzollern-Sigm';
  assert.equal(long.length, 63);
  for (const name of [long, `${long}x`]) {
    assert.equal(redact(`USERNAME=${name}\nowner ${name}!`), 'USERNAME=<user>\nowner <user>!', name);
  }
  // Past 64 characters a name is not hunted (MAX_HUNTED_NAME); its path
  // segment and environment value are still masked.
  const tooLong = `${long}xy`;
  assert.equal(redact(`USERNAME=${tooLong}\nowner ${tooLong}!`), `USERNAME=<user>\nowner ${tooLong}!`);
});
