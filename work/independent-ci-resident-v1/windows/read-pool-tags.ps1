# read-pool-tags.ps1 (docs/architecture.md section 9.1, the kernel pool alert; src/pool-alert.mjs reads its output).
#
# Read-only and unprivileged. Two reads, nothing else:
#   - the kernel's pool tag table through NtQuerySystemInformation(SystemPoolTagInformation = 22), the same read
#     D:/w/tmp/leak/toke-count.ps1 made without elevation; only the tag with the most paged pool bytes in use is printed;
#   - K32GetPerformanceInfo (kernel32): the paged pool in total, the commit charge and the commit limit.
# Prints one line of JSON:
#   {"contract":"clued.independent-ci.pool-reading/1","top":{"tag":"Toke","pagedBytes":5619316736,"pagedCount":2582116},
#    "pagedPoolBytes":6012345678,"commitBytes":40000000000,"commitLimitBytes":80000000000}
# pagedBytes: the tag's PagedUsed; pagedCount: its allocations not yet freed. The companion never looks at a tag's name to decide.
# Any failure: exit 1 and nothing on stdout. No Add-Type (it compiles through csc.exe and needs a writable TEMP): the native calls
# are emitted in memory. ASCII only.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

try {
  if ([IntPtr]::Size -ne 8) { exit 1 }   # the layouts below are the 64-bit ones
  $name = New-Object Reflection.AssemblyName 'CluedPoolReading'
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('CluedPoolReading')
  $type = $module.DefineType('CluedPoolReadingNative', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $m1 = $type.DefinePInvokeMethod('NtQuerySystemInformation', 'ntdll.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl',
    [Reflection.CallingConventions]::Standard, [int], [Type[]]@([int], [IntPtr], [int], [int].MakeByRefType()),
    [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $m1.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $m2 = $type.DefinePInvokeMethod('K32GetPerformanceInfo', 'kernel32.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl',
    [Reflection.CallingConventions]::Standard, [int], [Type[]]@([IntPtr], [int]),
    [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $m2.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $native = $type.CreateType()
  $marshal = [Runtime.InteropServices.Marshal]
  $inv = [Globalization.CultureInfo]::InvariantCulture

  $length = 4MB
  $buffer = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    $buffer = $marshal::AllocHGlobal($length)
    $needed = 0
    $status = $native::NtQuerySystemInformation(22, $buffer, $length, [ref]$needed)
    if ($status -eq 0) { break }
    $marshal::FreeHGlobal($buffer)
    $buffer = [IntPtr]::Zero
    if ($status -ne -1073741820) { exit 1 }   # anything but STATUS_INFO_LENGTH_MISMATCH (0xC0000004)
    $length = [Math]::Max($length * 2, $needed + 1MB)
  }
  if ($buffer -eq [IntPtr]::Zero) { exit 1 }

  # SYSTEM_POOLTAG_INFORMATION: ULONG Count, then (8-aligned) SYSTEM_POOLTAG[Count] of 40 bytes each:
  #   0 Tag[4], 4 PagedAllocs, 8 PagedFrees, 16 PagedUsed (SIZE_T), 24 NonPagedAllocs, 28 NonPagedFrees, 32 NonPagedUsed (SIZE_T)
  $count = $marshal::ReadInt32($buffer, 0)
  if ($count -lt 1 -or (8 + [int64]$count * 40) -gt $length) { exit 1 }
  $best = -1
  $bestUsed = [int64]0
  for ($i = 0; $i -lt $count; $i++) {
    $used = $marshal::ReadInt64($buffer, 8 + $i * 40 + 16)
    if ($used -gt $bestUsed) { $bestUsed = $used; $best = $i }
  }
  if ($best -lt 0) { exit 1 }
  $offset = 8 + $best * 40
  $allocs = [int64]([uint32]($marshal::ReadInt32($buffer, $offset + 4) -band 0xFFFFFFFFL))
  $frees = [int64]([uint32]($marshal::ReadInt32($buffer, $offset + 8) -band 0xFFFFFFFFL))
  $live = $allocs - $frees
  if ($live -lt 0) { $live += 4294967296 }
  $tag = New-Object Text.StringBuilder
  for ($k = 0; $k -lt 4; $k++) {
    $b = $marshal::ReadByte($buffer, $offset + $k)
    if ($b -ge 0x20 -and $b -le 0x7E -and $b -ne 0x22 -and $b -ne 0x5C) { [void]$tag.Append([char]$b) } else { [void]$tag.Append('?') }
  }
  $marshal::FreeHGlobal($buffer)

  # PERFORMANCE_INFORMATION (104 bytes): 0 cb (DWORD), 8 CommitTotal, 16 CommitLimit, 24 CommitPeak, 32 PhysicalTotal,
  # 40 PhysicalAvailable, 48 SystemCache, 56 KernelTotal, 64 KernelPaged, 72 KernelNonpaged, 80 PageSize (SIZE_T; all in pages, PageSize in bytes)
  $perf = $marshal::AllocHGlobal(104)
  $marshal::WriteInt32($perf, 0, 104)
  if ($native::K32GetPerformanceInfo($perf, 104) -eq 0) { $marshal::FreeHGlobal($perf); exit 1 }
  $page = $marshal::ReadInt64($perf, 80)
  $commit = $marshal::ReadInt64($perf, 8) * $page
  $limit = $marshal::ReadInt64($perf, 16) * $page
  $paged = $marshal::ReadInt64($perf, 64) * $page
  $marshal::FreeHGlobal($perf)
  if ($page -le 0 -or $limit -le 0 -or $paged -le 0) { exit 1 }

  $out = '{"contract":"clued.independent-ci.pool-reading/1","top":{"tag":"' + $tag.ToString() + '","pagedBytes":' + $bestUsed.ToString($inv) +
    ',"pagedCount":' + $live.ToString($inv) + '},"pagedPoolBytes":' + $paged.ToString($inv) + ',"commitBytes":' + $commit.ToString($inv) +
    ',"commitLimitBytes":' + $limit.ToString($inv) + '}'
  [Console]::Out.Write($out)
  [Console]::Out.Write("`n")
  exit 0
} catch {
  exit 1
}
