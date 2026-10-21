"""验证工具专用的独立字节定位；不调用 MoonBit 解析器。"""
import struct


class RecordingInput:
    def __init__(self, stream):
        self.stream = stream
        self.parts = []
        self.offset = 0

    def read(self, size):
        if size > 16777216:
            raise ValueError('独立对照单条记录超过 16 MiB')
        data = self.stream.read(size)
        self.parts.append(data)
        self.offset += len(data)
        return data

    def close(self):
        self.stream.close()


class ReferenceRecord(dict):
    def __init__(self, data, raw, offset, peer_frame):
        super().__init__(data)
        self.raw, self.offset, self.peer_frame = raw, offset, peer_frame


def attribute_blocks(frame):
    """仅定位原始属性区；ASN/IP/NLRI 的解释仍来自 mrtparse。"""
    kind, subtype = struct.unpack_from('!HH', frame, 4)
    if kind == 13 and subtype in (2, 4, 8, 10):
        bits = frame[16]
        position = 17 + (bits + 7) // 8
        count = struct.unpack_from('!H', frame, position)[0]
        position += 2
        blocks = []
        for _ in range(count):
            position += 6 + (4 if subtype in (8, 10) else 0)
            size = struct.unpack_from('!H', frame, position)[0]
            position += 2
            if position + size > len(frame):
                raise ValueError('原始 RIB 属性长度越界')
            blocks.append(frame[position:position + size])
            position += size
        return blocks
    if kind not in (16, 17) or subtype not in (1, 4, 6, 7, 8, 9, 10, 11):
        return []
    position = 12 + (4 if kind == 17 else 0)
    width = 4 if subtype in (4, 7, 9, 11) else 2
    position += 2 * width + 2
    afi = struct.unpack_from('!H', frame, position)[0]
    position += 2 + (8 if afi == 1 else 32)
    if frame[position + 18] != 2:
        return []
    position += 19
    size = struct.unpack_from('!H', frame, position)[0]
    position += 2 + size
    size = struct.unpack_from('!H', frame, position)[0]
    position += 2
    if position + size > len(frame):
        raise ValueError('原始 UPDATE 属性长度越界')
    return [frame[position:position + size]]


def raw_attributes(block):
    position, result = 0, []
    while position < len(block):
        flags, code = block[position:position + 2]
        position += 2
        size = struct.unpack_from('!H', block, position)[0] if flags & 16 else block[position]
        position += 2 if flags & 16 else 1
        if position + size > len(block):
            raise ValueError('原始属性 TLV 越界')
        result.append((code, flags, block[position:position + size].hex()))
        position += size
    return tuple(result)
