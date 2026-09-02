package exec

import (
	"sort"
	"sync"
)

// AccountDemandRegistry tracks the venues currently displayed by Account
// panels. The connection id scopes panel ids, so a browser disconnect cannot
// leave a demand behind when a new window reuses the same panel id.
type AccountDemandRegistry struct {
	mu     sync.RWMutex
	byConn map[uint64]map[string]VenueID
}

func NewAccountDemandRegistry() *AccountDemandRegistry {
	return &AccountDemandRegistry{byConn: map[uint64]map[string]VenueID{}}
}

// Set records one panel's selected venue. An empty venue releases that panel.
func (r *AccountDemandRegistry) Set(connID uint64, panelID string, venue VenueID) {
	if r == nil || panelID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.byConn[connID]
	if venue == "" {
		if m != nil {
			delete(m, panelID)
			if len(m) == 0 {
				delete(r.byConn, connID)
			}
		}
		return
	}
	if m == nil {
		m = map[string]VenueID{}
		r.byConn[connID] = m
	}
	m[panelID] = venue
}

func (r *AccountDemandRegistry) ReleaseConnection(connID uint64) {
	if r == nil {
		return
	}
	r.mu.Lock()
	delete(r.byConn, connID)
	r.mu.Unlock()
}

// Venues returns each selected venue once in stable order.
func (r *AccountDemandRegistry) Venues() []VenueID {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	set := map[VenueID]struct{}{}
	for _, panels := range r.byConn {
		for _, venue := range panels {
			if venue != "" {
				set[venue] = struct{}{}
			}
		}
	}
	r.mu.RUnlock()
	out := make([]VenueID, 0, len(set))
	for venue := range set {
		out = append(out, venue)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
