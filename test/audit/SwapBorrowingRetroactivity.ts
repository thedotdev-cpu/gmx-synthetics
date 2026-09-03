import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getPositionKeys } from "../../utils/position";
import { prices } from "../../utils/prices";
import * as keys from "../../utils/keys";

describe("AUDIT: swap-path borrowing checkpoint", () => {
  it("lets a swap rewrite the rate applied to already elapsed borrowing time", async () => {
    const fixture = await deployFixture();
    const { user0, user1 } = fixture.accounts;
    const { reader, dataStore, referralStorage, ethUsdMarket, wnt, usdc } = fixture.contracts;

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(5_000_000, 6),
      },
    });

    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 7));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));

    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200_000),
        acceptablePrice: expandDecimals(5050, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    const [positionKey] = await getPositionKeys(dataStore, 0, 1);
    const updatedAtBefore = await dataStore.getUint(
      keys.cumulativeBorrowingFactorUpdatedAtKey(ethUsdMarket.marketToken, true)
    );
    const cumulativeBefore = await dataStore.getUint(
      keys.cumulativeBorrowingFactorKey(ethUsdMarket.marketToken, true)
    );

    await time.increase(14 * 24 * 60 * 60);

    const infoBeforeSwap = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKey,
      prices.ethUsdMarket,
      0,
      ethers.constants.AddressZero,
      true
    );
    const feeBeforeSwap = infoBeforeSwap.fees.borrowing.borrowingFeeUsd;
    expect(feeBeforeSwap).gt(0);

    // A pure swap changes the real market's long-token pool amount. ExecuteOrderUtils
    // checkpoints only its zero-valued order.market, and SwapUtils does not checkpoint
    // the swap-path market before changing poolAmount.
    await handleOrder(fixture, {
      create: {
        account: user1,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(100, 18),
        acceptablePrice: 0,
        orderType: OrderType.MarketSwap,
        swapPath: [ethUsdMarket.marketToken],
        executionFee: expandDecimals(1, 15),
      },
    });

    expect(
      await dataStore.getUint(keys.cumulativeBorrowingFactorUpdatedAtKey(ethUsdMarket.marketToken, true))
    ).eq(updatedAtBefore);
    expect(await dataStore.getUint(keys.cumulativeBorrowingFactorKey(ethUsdMarket.marketToken, true))).eq(
      cumulativeBefore
    );

    const infoAfterSwap = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKey,
      prices.ethUsdMarket,
      0,
      ethers.constants.AddressZero,
      true
    );
    const feeAfterSwap = infoAfterSwap.fees.borrowing.borrowingFeeUsd;

    // Increasing the long-token pool lowers the current borrowing rate. Because the
    // old clock was not checkpointed, that lower post-swap rate is applied to all
    // fourteen already elapsed days, reducing debt that had already accrued.
    expect(feeAfterSwap).lt(feeBeforeSwap);
    expect(feeBeforeSwap.sub(feeAfterSwap)).gt(feeBeforeSwap.div(100));
  });
});
