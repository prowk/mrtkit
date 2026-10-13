# mrtkit

用 MoonBit 开发的 BGP MRT 解析库与离线路由变化分析工具。

开发按可独立验证的功能推进：安全二进制读取、MRT 分帧、IP 前缀、BGP 属性、路由快照、更新消息、IPv6、多记录处理、查询导出、变化分析、流式 CLI 和真实数据验证。

协议依据：[RFC 6396](https://datatracker.ietf.org/doc/html/rfc6396)、[RFC 4271](https://datatracker.ietf.org/doc/html/rfc4271)、[RFC 4760](https://datatracker.ietf.org/doc/html/rfc4760)、[RFC 6793](https://datatracker.ietf.org/doc/html/rfc6793)。

开发环境：MoonBit 0.1.20260920，Node.js 22 或更新版本。库不依赖第三方 MoonBit 包。

```powershell
moon check
moon test
```
