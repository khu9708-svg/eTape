package moomoo

import (
	"context"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/earlisreal/eTape/engine/internal/clock"
	"github.com/earlisreal/eTape/engine/internal/feed/opend"
	"github.com/earlisreal/eTape/engine/internal/feed/opend/pb/common"
	"github.com/earlisreal/eTape/engine/internal/feed/opend/pb/qotcommon"
	"github.com/earlisreal/eTape/engine/internal/feed/opend/pb/trdcommon"
	"github.com/earlisreal/eTape/engine/internal/feed/opend/pb/trdgetmarginratio"
)

func TestTrdClient_GetMarginRatioMapsPermissionsAndAccount(t *testing.T) {
	m := newMockTrdOpenD(t)
	m.setRespond(opend.ProtoTrdGetMarginRatio, func(frame opend.Frame) proto.Message {
		var request trdgetmarginratio.Request
		if err := proto.Unmarshal(frame.Body, &request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.GetC2S().GetHeader().GetAccID() != testAccID {
			t.Errorf("account id = %d, want %d", request.GetC2S().GetHeader().GetAccID(), testAccID)
		}
		if trdcommon.TrdEnv(request.GetC2S().GetHeader().GetTrdEnv()) != trdcommon.TrdEnv_TrdEnv_Simulate {
			t.Errorf("trade environment = %v, want simulate", request.GetC2S().GetHeader().GetTrdEnv())
		}
		if len(request.GetC2S().GetSecurityList()) != 1 || request.GetC2S().GetSecurityList()[0].GetCode() != "AAPL" {
			t.Errorf("security list = %+v, want US AAPL", request.GetC2S().GetSecurityList())
		}
		return &trdgetmarginratio.Response{
			RetType: proto.Int32(int32(common.RetType_RetType_Succeed)),
			S2C: &trdgetmarginratio.S2C{Header: trdHeader(testAccID, "paper"), MarginRatioInfoList: []*trdgetmarginratio.MarginRatioInfo{{
				Security:      &qotcommon.Security{Market: proto.Int32(int32(qotcommon.QotMarket_QotMarket_US_Security)), Code: proto.String("AAPL")},
				IsLongPermit:  proto.Bool(true),
				IsShortPermit: proto.Bool(false),
			}}},
		}
	})
	tc := newTestTrdClient(t, m, testAccID, "paper", clock.System{})

	got, found, err := tc.getMarginRatio(context.Background(), "US.AAPL")
	if err != nil || !found || got.Marginable == nil || !*got.Marginable || got.Shortable == nil || *got.Shortable || got.Tradable != nil {
		t.Fatalf("eligibility = %#v found=%v err=%v", got, found, err)
	}
}
