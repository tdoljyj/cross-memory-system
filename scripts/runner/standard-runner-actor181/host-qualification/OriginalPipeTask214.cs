using System;
using System.Threading.Tasks;
using CluedLocalTransport181;
namespace CluedOriginalPipeTask214 {
 public static class Shim {
  public static Task Accept(LocalPipe pipe,int milliseconds){if(pipe==null||milliseconds<1||milliseconds>120000)throw new InvalidOperationException("OWNED_ACCEPT_BOUND");return Task.Run(()=>pipe.Accept(milliseconds));}
  public static Task<byte[]> ReceiveIdle(LocalPipe pipe,int milliseconds){if(pipe==null||milliseconds<1||milliseconds>180000)throw new InvalidOperationException("OWNED_IDLE_BOUND");return Task.Run(()=>pipe.ReceiveIdle(milliseconds));}
 }
}
