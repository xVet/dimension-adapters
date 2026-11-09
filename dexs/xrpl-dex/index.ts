import { CHAIN } from "../../helpers/chains";
import { Dependencies, FetchOptions, SimpleAdapter } from "../../adapters/types";
import { queryDuneSql } from "../../helpers/dune";

// dex_xrp_pair_volume_xrp + amm_xrp_volume_xrp miss AMM swaps filled by an OfferCreate (an offer that crosses an AMM
// pool). Counted from every ledger of 2026-10-19 to 2026-10-25 UTC, these were 3,012,422.73 of the 32,716,737.04 XRP
// traded against XRP (9.2%), and the values stored for that week equal the total without them to within 0.12% a day.
// An offer that trades with a pool leaves no Offer node for it, only balance changes on the pool's own account. The
// XRP side is the Balance change of the pool's AccountRoot (the one that carries AMMID), which is added here.
// Example: OfferCreate C21467AEFB6DBE06F84396CADF8B6DAFCF5BDD3ECFF9C444F7B3DCD4D2818BD9 (ledger 107874568) takes
// 11,999.917242 XRP from the RLUSD/XRP pool rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3 for 15,400.40075695042 RLUSD.
// Drop the added term if amm_xrp_volume_xrp starts to include these swaps.
const fetch = async (options: FetchOptions) => {
    const formattedDate = options.dateString

    const query = `
        SELECT
            m.dex_xrp_pair_volume_xrp,
            m.amm_xrp_volume_xrp,
            o.pool_changes AS amm_offer_pool_changes,
            o.volume_xrp AS amm_offer_volume_xrp
        FROM xrpl.aggregated_metrics_daily m
        CROSS JOIN (
            SELECT
                COUNT(*) AS pool_changes,
                SUM(ABS(
                    CAST(json_extract_scalar(n, '$.ModifiedNode.FinalFields.Balance.value') AS DECIMAL(38, 0))
                    - CAST(json_extract_scalar(n, '$.ModifiedNode.PreviousFields.Balance.value') AS DECIMAL(38, 0))
                )) / 1e6 AS volume_xrp
            FROM xrpl.transactions t
            CROSS JOIN UNNEST(CAST(json_extract(t.metadata, '$.AffectedNodes') AS ARRAY(JSON))) AS u(n)
            WHERE t.ledger_close_date = DATE '${formattedDate}'
                AND t.transaction_type = 'OfferCreate'
                AND t.result = 'tesSUCCESS'
                AND strpos(t.metadata, 'AMMID') > 0
                AND json_extract_scalar(n, '$.ModifiedNode.LedgerEntryType') = 'AccountRoot'
                AND json_extract_scalar(n, '$.ModifiedNode.FinalFields.AMMID') IS NOT NULL
                AND json_extract_scalar(n, '$.ModifiedNode.PreviousFields.Balance.value') IS NOT NULL
        ) o
        WHERE m.date = DATE '${formattedDate}'
    `;
    const queryResults = await queryDuneSql(options, query);

    if (!queryResults.length) {
        throw new Error(`no row in xrpl.aggregated_metrics_daily for ${formattedDate} yet`);
    }

    const { dex_xrp_pair_volume_xrp, amm_xrp_volume_xrp, amm_offer_pool_changes, amm_offer_volume_xrp } = queryResults[0];
    if (dex_xrp_pair_volume_xrp == null || amm_xrp_volume_xrp == null) {
        throw new Error(`null volume in xrpl.aggregated_metrics_daily for ${formattedDate}`);
    }
    // offers fill against AMM pools every day (11,794 to 22,544 pool changes a day in the week above): none means
    // xrpl.transactions does not have the day yet
    if (!Number(amm_offer_pool_changes)) {
        throw new Error(`no AMM swaps filled by offers in xrpl.transactions for ${formattedDate} yet`);
    }

    const dailyVolume = options.createBalances();
    dailyVolume.addCGToken("ripple", Number(dex_xrp_pair_volume_xrp) + Number(amm_xrp_volume_xrp) + Number(amm_offer_volume_xrp));

    return { dailyVolume };
};

const adapter: SimpleAdapter = {
    version: 1,
    fetch,
    dependencies: [Dependencies.DUNE],
    chains: [CHAIN.RIPPLE],
    start: '2025-03-19',
    isExpensiveAdapter: true,
    methodology: {
        Volume: "XRP side of every trade in an XRP pair on the XRP Ledger's native DEX, from order book fills and AMM pool swaps (including offers that trade against a pool); trades between two other tokens count only through their legs bridged via XRP.",
    },
};

export default adapter;
