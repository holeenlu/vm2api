package codexgateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"hash/crc64"
	"io"
)

// 按 XZ 索引随机读取（对齐 codex-proxy-rs platform_release/xz.rs）：只解码被访问的块，每次只缓存一个已校验的块，
// 用于在 Linux DEB 的 data.tar.xz 中跳过无关文件。块内为 LZMA2 单过滤器；解码器为纯 Go 实现（无外部依赖）。
const (
	xzMaxBlock      = 64 << 20
	xzMaxBlocks     = 4096
	xzMaxTotal      = 4 << 30
	xzMaxIndexBytes = 1 << 20
)

var errXZ = errors.New("invalid xz stream")

type xzBlock struct {
	unpadded, unpacked, offset, position uint64
}

type indexedXZ struct {
	source   io.ReaderAt
	check    byte
	blocks   []xzBlock
	size     uint64
	position uint64
	cached   int
	buffer   []byte
}

func readVLI(data []byte, cursor *int) (uint64, error) {
	var value uint64
	for shift := 0; shift < 63; shift += 7 {
		if *cursor >= len(data) {
			return 0, errXZ
		}
		b := data[*cursor]
		*cursor++
		value |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			if shift > 0 && b == 0 {
				return 0, errXZ
			}
			return value, nil
		}
	}
	return 0, errXZ
}

func newIndexedXZ(source io.ReaderAt, start, length uint64) (*indexedXZ, error) {
	if length < 32 {
		return nil, errXZ
	}
	header := make([]byte, 12)
	if _, err := source.ReadAt(header, int64(start)); err != nil {
		return nil, err
	}
	if !bytes.Equal(header[:6], []byte("\xfd7zXZ\x00")) || crc32.ChecksumIEEE(header[6:8]) != binary.LittleEndian.Uint32(header[8:12]) {
		return nil, errXZ
	}
	footer := make([]byte, 12)
	if _, err := source.ReadAt(footer, int64(start+length-12)); err != nil {
		return nil, err
	}
	if !bytes.Equal(footer[10:], []byte("YZ")) || !bytes.Equal(footer[8:10], header[6:8]) || crc32.ChecksumIEEE(footer[4:10]) != binary.LittleEndian.Uint32(footer[:4]) {
		return nil, errXZ
	}
	indexSize := (uint64(binary.LittleEndian.Uint32(footer[4:8])) + 1) * 4
	if indexSize > xzMaxIndexBytes || indexSize > length-24 {
		return nil, errXZ
	}
	index := make([]byte, indexSize)
	if _, err := source.ReadAt(index, int64(start+length-12-indexSize)); err != nil {
		return nil, err
	}
	if index[0] != 0 || crc32.ChecksumIEEE(index[:len(index)-4]) != binary.LittleEndian.Uint32(index[len(index)-4:]) {
		return nil, errXZ
	}
	cursor := 1
	count, err := readVLI(index, &cursor)
	if err != nil || count == 0 || count > xzMaxBlocks {
		return nil, errXZ
	}
	out := &indexedXZ{source: source, check: header[7] & 0x0f, cached: -1}
	offset := start + 12
	for i := uint64(0); i < count; i++ {
		unpadded, err1 := readVLI(index, &cursor)
		unpacked, err2 := readVLI(index, &cursor)
		if err1 != nil || err2 != nil || unpadded == 0 || unpadded > xzMaxBlock || unpacked == 0 || unpacked > xzMaxBlock {
			return nil, errXZ
		}
		out.blocks = append(out.blocks, xzBlock{unpadded: unpadded, unpacked: unpacked, offset: offset, position: out.size})
		offset += (unpadded + 3) &^ 3
		out.size += unpacked
		if out.size > xzMaxTotal {
			return nil, errXZ
		}
	}
	if offset != start+length-12-indexSize || cursor > len(index)-4 {
		return nil, errXZ
	}
	for _, b := range index[cursor : len(index)-4] {
		if b != 0 {
			return nil, errXZ
		}
	}
	return out, nil
}

func xzCheckSize(check byte) (int, bool) {
	switch check {
	case 0:
		return 0, true
	case 1:
		return 4, true
	case 4:
		return 8, true
	case 10:
		return 32, true
	}
	return 0, false
}

// decodeBlock 解析块头（只接受单个 LZMA2 过滤器）、解码并校验长度与校验和。
func (x *indexedXZ) decodeBlock(block xzBlock) ([]byte, error) {
	// 布局为 块头 + 压缩数据 + 填充 + 校验；Unpadded Size 不含填充
	raw := make([]byte, (block.unpadded+3)&^3)
	if _, err := x.source.ReadAt(raw, int64(block.offset)); err != nil {
		return nil, err
	}
	headerSize := (int(raw[0]) + 1) * 4
	if raw[0] == 0 || headerSize > len(raw) || crc32.ChecksumIEEE(raw[:headerSize-4]) != binary.LittleEndian.Uint32(raw[headerSize-4:headerSize]) {
		return nil, errXZ
	}
	flags := raw[1]
	if flags&0x3c != 0 || flags&0x03 != 0 {
		return nil, errXZ
	}
	cursor := 2
	if flags&0x40 != 0 {
		if _, err := readVLI(raw[:headerSize-4], &cursor); err != nil {
			return nil, err
		}
	}
	if flags&0x80 != 0 {
		size, err := readVLI(raw[:headerSize-4], &cursor)
		if err != nil || size != block.unpacked {
			return nil, errXZ
		}
	}
	filter, err := readVLI(raw[:headerSize-4], &cursor)
	if err != nil || filter != 0x21 {
		return nil, errXZ
	}
	propsSize, err := readVLI(raw[:headerSize-4], &cursor)
	if err != nil || propsSize != 1 || cursor >= headerSize-4 {
		return nil, errXZ
	}
	dictBits := raw[cursor]
	if dictBits > 40 {
		return nil, errXZ
	}
	checkSize, ok := xzCheckSize(x.check)
	if !ok || int(block.unpadded) < headerSize+checkSize {
		return nil, errXZ
	}
	compressedEnd := int(block.unpadded) - checkSize
	for _, b := range raw[compressedEnd : len(raw)-checkSize] {
		if b != 0 {
			return nil, errXZ
		}
	}
	out, err := decodeLZMA2(raw[headerSize:compressedEnd], int(block.unpacked))
	if err != nil {
		return nil, err
	}
	check := raw[len(raw)-checkSize:]
	switch x.check {
	case 1:
		if crc32.ChecksumIEEE(out) != binary.LittleEndian.Uint32(check) {
			return nil, errXZ
		}
	case 4:
		if crc64.Checksum(out, crc64.MakeTable(crc64.ECMA)) != binary.LittleEndian.Uint64(check) {
			return nil, errXZ
		}
	case 10:
		sum := sha256.Sum256(out)
		if !bytes.Equal(sum[:], check) {
			return nil, errXZ
		}
	}
	return out, nil
}

func (x *indexedXZ) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if x.position >= x.size {
		return 0, io.EOF
	}
	index := 0
	for i := range x.blocks {
		if x.blocks[i].position <= x.position {
			index = i
		} else {
			break
		}
	}
	block := x.blocks[index]
	if x.cached != index {
		data, err := x.decodeBlock(block)
		if err != nil {
			return 0, err
		}
		x.buffer, x.cached = data, index
	}
	offset := int(x.position - block.position)
	n := copy(p, x.buffer[offset:])
	x.position += uint64(n)
	return n, nil
}

func (x *indexedXZ) Seek(offset int64, whence int) (int64, error) {
	var next int64
	switch whence {
	case io.SeekStart:
		next = offset
	case io.SeekCurrent:
		next = int64(x.position) + offset
	case io.SeekEnd:
		next = int64(x.size) + offset
	}
	if next < 0 || uint64(next) > x.size {
		return 0, errXZ
	}
	x.position = uint64(next)
	return next, nil
}

// --- LZMA2 / LZMA 解码（按 LZMA 规范的参考实现；字典即输出缓冲，块之间相互独立） ---

const (
	lzmaBitModelTotal = 1 << 11
	lzmaMoveBits      = 5
	lzmaTopValue      = 1 << 24
	lzmaMatchMinLen   = 2
	lzmaEndPosIndex   = 14
	lzmaFullDistances = 128
	lzmaAlignBits     = 4
)

type rangeDecoder struct {
	data  []byte
	pos   int
	rng   uint32
	code  uint32
	error bool
}

func (r *rangeDecoder) init(data []byte) bool {
	if len(data) < 5 || data[0] != 0 {
		return false
	}
	r.data, r.pos, r.rng, r.code, r.error = data, 5, 0xffffffff, binary.BigEndian.Uint32(data[1:5]), false
	return r.code != r.rng
}

func (r *rangeDecoder) next() byte {
	if r.pos >= len(r.data) {
		r.error = true
		return 0
	}
	b := r.data[r.pos]
	r.pos++
	return b
}

func (r *rangeDecoder) normalize() {
	if r.rng < lzmaTopValue {
		r.rng <<= 8
		r.code = r.code<<8 | uint32(r.next())
	}
}

func (r *rangeDecoder) bit(prob *uint16) uint32 {
	v := uint32(*prob)
	bound := (r.rng >> 11) * v
	var symbol uint32
	if r.code < bound {
		v += (lzmaBitModelTotal - v) >> lzmaMoveBits
		r.rng = bound
	} else {
		v -= v >> lzmaMoveBits
		r.code -= bound
		r.rng -= bound
		symbol = 1
	}
	*prob = uint16(v)
	r.normalize()
	return symbol
}

func (r *rangeDecoder) direct(bits int) uint32 {
	var result uint32
	for ; bits > 0; bits-- {
		r.rng >>= 1
		r.code -= r.rng
		t := 0 - (r.code >> 31)
		r.code += r.rng & t
		if r.code == r.rng {
			r.error = true
		}
		r.normalize()
		result = result<<1 + (t + 1)
	}
	return result
}

func bitTree(r *rangeDecoder, probs []uint16, bits int) uint32 {
	m := uint32(1)
	for i := 0; i < bits; i++ {
		m = m<<1 + r.bit(&probs[m])
	}
	return m - (1 << bits)
}

func bitTreeReverse(r *rangeDecoder, probs []uint16, bits int) uint32 {
	m, symbol := uint32(1), uint32(0)
	for i := 0; i < bits; i++ {
		bit := r.bit(&probs[m])
		m = m<<1 + bit
		symbol |= bit << i
	}
	return symbol
}

type lenDecoder struct {
	choice, choice2 uint16
	low, mid        [16][8]uint16
	high            [256]uint16
}

func (l *lenDecoder) reset() {
	l.choice, l.choice2 = lzmaBitModelTotal/2, lzmaBitModelTotal/2
	for i := range l.low {
		for j := range l.low[i] {
			l.low[i][j], l.mid[i][j] = lzmaBitModelTotal/2, lzmaBitModelTotal/2
		}
	}
	for i := range l.high {
		l.high[i] = lzmaBitModelTotal / 2
	}
}

func (l *lenDecoder) decode(r *rangeDecoder, posState int) uint32 {
	if r.bit(&l.choice) == 0 {
		return bitTree(r, l.low[posState][:], 3)
	}
	if r.bit(&l.choice2) == 0 {
		return 8 + bitTree(r, l.mid[posState][:], 3)
	}
	return 16 + bitTree(r, l.high[:], 8)
}

type lzmaState struct {
	lc, lp, pb        int
	literals          []uint16
	isMatch, isRep0L  [192]uint16
	isRep, isRepG0    [12]uint16
	isRepG1, isRepG2  [12]uint16
	posSlot           [4][64]uint16
	posDecoders       [1 + lzmaFullDistances - lzmaEndPosIndex]uint16
	align             [1 << lzmaAlignBits]uint16
	length, repLength lenDecoder
	state             int
	rep0, rep1, rep2  uint32
	rep3              uint32
	propsSet          bool
}

func (s *lzmaState) resetProbabilities() {
	size := 0x300 << (s.lc + s.lp)
	if cap(s.literals) < size {
		s.literals = make([]uint16, size)
	}
	s.literals = s.literals[:size]
	half := uint16(lzmaBitModelTotal / 2)
	for i := range s.literals {
		s.literals[i] = half
	}
	for _, table := range [][]uint16{s.isMatch[:], s.isRep0L[:], s.isRep[:], s.isRepG0[:], s.isRepG1[:], s.isRepG2[:], s.posDecoders[:], s.align[:]} {
		for i := range table {
			table[i] = half
		}
	}
	for i := range s.posSlot {
		for j := range s.posSlot[i] {
			s.posSlot[i][j] = half
		}
	}
	s.length.reset()
	s.repLength.reset()
	s.state, s.rep0, s.rep1, s.rep2, s.rep3 = 0, 0, 0, 0, 0
}

// decodeLZMA2 解码一个 LZMA2 流（以 0x00 控制字节结束），输出长度必须等于 expected。
func decodeLZMA2(data []byte, expected int) ([]byte, error) {
	out := make([]byte, 0, expected)
	var st lzmaState
	dictStart := 0
	pos := 0
	first := true
	for {
		if pos >= len(data) {
			return nil, errXZ
		}
		control := data[pos]
		pos++
		if control == 0x00 {
			break
		}
		if control == 0x01 || control == 0x02 {
			if pos+2 > len(data) {
				return nil, errXZ
			}
			size := int(binary.BigEndian.Uint16(data[pos:])) + 1
			pos += 2
			if pos+size > len(data) || len(out)+size > expected || (first && control != 0x01) {
				return nil, errXZ
			}
			if control == 0x01 {
				dictStart = len(out)
			}
			out = append(out, data[pos:pos+size]...)
			pos += size
			first = false
			continue
		}
		if control < 0x80 || pos+4 > len(data) {
			return nil, errXZ
		}
		unpacked := int(control&0x1f)<<16 + int(binary.BigEndian.Uint16(data[pos:])) + 1
		packed := int(binary.BigEndian.Uint16(data[pos+2:])) + 1
		pos += 4
		reset := (control >> 5) & 3
		if first && reset != 3 {
			return nil, errXZ
		}
		if reset == 3 {
			dictStart = len(out)
		}
		if reset >= 2 {
			if pos >= len(data) {
				return nil, errXZ
			}
			props := int(data[pos])
			pos++
			if props >= 9*5*5 {
				return nil, errXZ
			}
			st.lc, st.lp, st.pb = props%9, (props/9)%5, props/45
			if st.lc+st.lp > 4 {
				return nil, errXZ
			}
			st.propsSet = true
		}
		if !st.propsSet {
			return nil, errXZ
		}
		if reset >= 1 {
			st.resetProbabilities()
		}
		if pos+packed > len(data) || len(out)+unpacked > expected {
			return nil, errXZ
		}
		var rc rangeDecoder
		if !rc.init(data[pos : pos+packed]) {
			return nil, errXZ
		}
		var err error
		out, err = st.decode(&rc, out, dictStart, len(out)+unpacked)
		if err != nil {
			return nil, err
		}
		pos += packed
		first = false
	}
	if len(out) != expected {
		return nil, errXZ
	}
	return out, nil
}

func (s *lzmaState) decode(r *rangeDecoder, out []byte, dictStart, limit int) ([]byte, error) {
	pbMask := 1<<s.pb - 1
	lpMask := 1<<s.lp - 1
	for len(out) < limit {
		if r.error {
			return nil, errXZ
		}
		total := len(out) - dictStart
		posState := total & pbMask
		if r.bit(&s.isMatch[s.state<<4|posState]) == 0 {
			prev := 0
			if total > 0 {
				prev = int(out[len(out)-1])
			}
			base := 0x300 * (((total & lpMask) << s.lc) + (prev >> (8 - s.lc)))
			probs := s.literals[base : base+0x300]
			symbol := uint32(1)
			if s.state >= 7 {
				if int(s.rep0) >= total {
					return nil, errXZ
				}
				matchByte := uint32(out[len(out)-int(s.rep0)-1])
				for symbol < 0x100 {
					matchBit := (matchByte >> 7) & 1
					matchByte <<= 1
					bit := r.bit(&probs[((1+matchBit)<<8)+symbol])
					symbol = symbol<<1 | bit
					if matchBit != bit {
						break
					}
				}
			}
			for symbol < 0x100 {
				symbol = symbol<<1 | r.bit(&probs[symbol])
			}
			out = append(out, byte(symbol-0x100))
			switch {
			case s.state < 4:
				s.state = 0
			case s.state < 10:
				s.state -= 3
			default:
				s.state -= 6
			}
			continue
		}
		var length uint32
		if r.bit(&s.isRep[s.state]) != 0 {
			if total == 0 {
				return nil, errXZ
			}
			if r.bit(&s.isRepG0[s.state]) == 0 {
				if r.bit(&s.isRep0L[s.state<<4|posState]) == 0 {
					if s.state < 7 {
						s.state = 9
					} else {
						s.state = 11
					}
					if int(s.rep0) >= total {
						return nil, errXZ
					}
					out = append(out, out[len(out)-int(s.rep0)-1])
					continue
				}
			} else {
				var distance uint32
				if r.bit(&s.isRepG1[s.state]) == 0 {
					distance = s.rep1
				} else {
					if r.bit(&s.isRepG2[s.state]) == 0 {
						distance = s.rep2
					} else {
						distance = s.rep3
						s.rep3 = s.rep2
					}
					s.rep2 = s.rep1
				}
				s.rep1 = s.rep0
				s.rep0 = distance
			}
			length = s.repLength.decode(r, posState)
			if s.state < 7 {
				s.state = 8
			} else {
				s.state = 11
			}
		} else {
			s.rep3, s.rep2, s.rep1 = s.rep2, s.rep1, s.rep0
			length = s.length.decode(r, posState)
			if s.state < 7 {
				s.state = 7
			} else {
				s.state = 10
			}
			lenState := length
			if lenState > 3 {
				lenState = 3
			}
			slot := bitTree(r, s.posSlot[lenState][:], 6)
			distance := slot
			if slot >= 4 {
				direct := int(slot>>1) - 1
				distance = (2 | (slot & 1)) << direct
				if slot < lzmaEndPosIndex {
					distance += bitTreeReverse(r, s.posDecoders[distance-slot:], direct)
				} else {
					distance += r.direct(direct-lzmaAlignBits) << lzmaAlignBits
					distance += bitTreeReverse(r, s.align[:], lzmaAlignBits)
				}
			}
			s.rep0 = distance
			if s.rep0 == 0xffffffff {
				return nil, errXZ
			}
		}
		length += lzmaMatchMinLen
		if int(s.rep0) >= total || len(out)+int(length) > limit {
			return nil, errXZ
		}
		for i := uint32(0); i < length; i++ {
			out = append(out, out[len(out)-int(s.rep0)-1])
		}
	}
	if r.error {
		return nil, errXZ
	}
	return out, nil
}
