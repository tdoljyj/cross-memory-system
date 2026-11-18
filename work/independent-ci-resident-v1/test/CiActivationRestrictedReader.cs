using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace CiActivationFixture {
    public static class RestrictedReader {
        [StructLayout(LayoutKind.Sequential)]
        struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }

        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool CreateRestrictedToken(IntPtr original, uint flags, uint disabledCount, IntPtr disabled,
            uint deletedCount, IntPtr deleted, uint restrictingCount, ref SidAndAttributes restricting, out SafeAccessTokenHandle handle);

        // 使用当前进程可获得的权限，加入测试节点账号 SID 作为第二次访问检查。
        public static bool CanRead(string path, string account) {
            var sid = new SecurityIdentifier(account);
            var bytes = new byte[sid.BinaryLength];
            sid.GetBinaryForm(bytes, 0);
            var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try {
                var restricting = new SidAndAttributes { Sid = pinned.AddrOfPinnedObject() };
                using (var identity = WindowsIdentity.GetCurrent()) {
                    SafeAccessTokenHandle token;
                    if (!CreateRestrictedToken(identity.Token, 0, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, ref restricting, out token))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    using (token)
                    using (WindowsIdentity.Impersonate(token.DangerousGetHandle())) {
                        try { using (var stream = File.OpenRead(path)) return stream.ReadByte() >= 0; }
                        catch (UnauthorizedAccessException) { return false; }
                    }
                }
            } finally { pinned.Free(); }
        }
    }
}
