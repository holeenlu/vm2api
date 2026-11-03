package codexgateway

import (
	"bytes"
	"io"
	"os"
	"testing"
)

func TestIndexedXZDecodesLZMA2BlocksAndSeeks(t *testing.T) {
	want, err := os.ReadFile("testdata/xz/sample.bin")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"multi.xz", "single.xz"} {
		data, err := os.ReadFile("testdata/xz/" + name)
		if err != nil {
			t.Fatal(err)
		}
		reader, err := newIndexedXZ(bytes.NewReader(data), 0, uint64(len(data)))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		got, err := io.ReadAll(reader)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s: decoded %d bytes err=%v", name, len(got), err)
		}
		// 随机读取：跳到后段只解码所在块
		if _, err := reader.Seek(int64(len(want)*3/4), io.SeekStart); err != nil {
			t.Fatal(err)
		}
		part := make([]byte, 4096)
		if _, err := io.ReadFull(reader, part); err != nil || !bytes.Equal(part, want[len(want)*3/4:len(want)*3/4+4096]) {
			t.Fatalf("%s: seek read mismatch %v", name, err)
		}
		// 篡改压缩数据必须被拒绝
		corrupt := append([]byte(nil), data...)
		corrupt[len(corrupt)/2] ^= 0x55
		if broken, err := newIndexedXZ(bytes.NewReader(corrupt), 0, uint64(len(corrupt))); err == nil {
			if out, err := io.ReadAll(broken); err == nil && bytes.Equal(out, want) {
				t.Fatalf("%s: corruption not detected", name)
			}
		}
	}
}
