package server

import "testing"

func TestMissingReadyDeviceCount(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		active int64
		ready  int64
		want   int64
	}{
		{name: "all ready", active: 3, ready: 3, want: 0},
		{name: "one missing", active: 3, ready: 2, want: 1},
		{name: "no ready devices", active: 2, ready: 0, want: 2},
		{name: "ready cannot exceed active", active: 1, ready: 2, want: 0},
		{name: "negative ready clamps", active: 2, ready: -1, want: 2},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := missingReadyDeviceCount(tc.active, tc.ready); got != tc.want {
				t.Fatalf("missingReadyDeviceCount(%d, %d) = %d, want %d", tc.active, tc.ready, got, tc.want)
			}
		})
	}
}
