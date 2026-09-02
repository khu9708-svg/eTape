package exec

import "testing"

func TestAccountDemandRegistryDeduplicatesAndReleases(t *testing.T) {
	r := NewAccountDemandRegistry()
	r.Set(1, "account-a", "alpaca-live")
	r.Set(2, "account-b", "alpaca-live")
	r.Set(2, "account-c", "moomoo-live")
	got := r.Venues()
	if len(got) != 2 || got[0] != "alpaca-live" || got[1] != "moomoo-live" {
		t.Fatalf("Venues() = %#v", got)
	}
	r.Set(1, "account-a", "")
	r.ReleaseConnection(2)
	if got := r.Venues(); len(got) != 0 {
		t.Fatalf("Venues() after release = %#v", got)
	}
}
