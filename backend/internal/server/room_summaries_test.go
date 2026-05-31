package server

import "testing"

func TestSortRoomSummariesOrdersByActivityThenID(t *testing.T) {
	t.Parallel()

	summaries := []RoomSummary{
		{ID: 1, LastActivityAt: "2026-05-15T08:00:00Z"},
		{ID: 3, LastActivityAt: "2026-05-16T08:00:00Z"},
		{ID: 2, LastActivityAt: "2026-05-16T08:00:00Z"},
	}

	sortRoomSummaries(summaries)

	if summaries[0].ID != 3 || summaries[1].ID != 2 || summaries[2].ID != 1 {
		t.Fatalf("unexpected summary order: %+v", summaries)
	}
}
