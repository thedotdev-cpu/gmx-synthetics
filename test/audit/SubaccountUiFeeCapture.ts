import { expect } from "chai";
import { setNextBlockBaseFeePerGas } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, DecreasePositionSwapType, executeOrder } from "../../utils/order";
import { hashString } from "../../utils/hash";
import * as keys from "../../utils/keys";

describe("AUDIT: subaccount UI fee capture", () => {
  it("lets a delegated subaccount charge and claim a UI fee from the principal", async () => {
    const fixture = await deployFixture();
    const { user0: principal, user1: subaccount } = fixture.accounts;
    const {
      dataStore,
      router,
      exchangeRouter,
      subaccountRouter,
      orderVault,
      ethUsdMarket,
      usdc,
    } = fixture.contracts;

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1_000_000, 6),
      },
    });

    await dataStore.setUint(keys.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR, decimalToFloat(1));
    await setNextBlockBaseFeePerGas(expandDecimals(1, 9));

    await subaccountRouter.connect(principal).addSubaccount(subaccount.address);
    await subaccountRouter
      .connect(principal)
      .setMaxAllowedSubaccountActionCount(subaccount.address, keys.SUBACCOUNT_ORDER_ACTION, 2);
    await subaccountRouter
      .connect(principal)
      .setSubaccountExpiresAt(subaccount.address, keys.SUBACCOUNT_ORDER_ACTION, 9_999_999_999);

    await usdc.mint(principal.address, expandDecimals(101, 6));
    await usdc.connect(principal).approve(router.address, expandDecimals(101, 6));

    const maxUiFeeFactor = await dataStore.getUint(keys.MAX_UI_FEE_FACTOR);
    expect(maxUiFeeFactor).gt(0);
    await exchangeRouter.connect(subaccount).setUiFeeFactor(maxUiFeeFactor);

    const params = {
      addresses: {
        receiver: principal.address,
        cancellationReceiver: principal.address,
        callbackContract: ethers.constants.AddressZero,
        uiFeeReceiver: subaccount.address,
        market: ethUsdMarket.marketToken,
        initialCollateralToken: usdc.address,
        swapPath: [],
      },
      numbers: {
        sizeDeltaUsd: decimalToFloat(1000),
        initialCollateralDeltaAmount: expandDecimals(100, 6),
        triggerPrice: 0,
        acceptablePrice: expandDecimals(5010, 12),
        executionFee: expandDecimals(1, 15),
        callbackGasLimit: 0,
        minOutputAmount: 0,
        validFromTime: 0,
      },
      orderType: OrderType.MarketIncrease,
      decreasePositionSwapType: DecreasePositionSwapType.NoSwap,
      isLong: true,
      shouldUnwrapNativeToken: false,
      referralCode: hashString("audit-referral"),
      dataList: [],
    };

    await subaccountRouter.connect(subaccount).multicall(
      [
        subaccountRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, expandDecimals(1, 15)]),
        subaccountRouter.interface.encodeFunctionData("createOrder", [principal.address, params]),
      ],
      { value: expandDecimals(1, 15) }
    );

    const principalUsdcBeforeExecution = await usdc.balanceOf(principal.address);
    expect(principalUsdcBeforeExecution).eq(expandDecimals(1, 6));

    await executeOrder(fixture);

    const claimableKey = keys.claimableUiFeeAmountKey(
      ethUsdMarket.marketToken,
      usdc.address,
      subaccount.address
    );
    const claimable = await dataStore.getUint(claimableKey);

    expect(claimable).gt(0);
    expect(claimable).eq(50_000); // 0.005% of a $1,000 increase, in 6-decimal USDC

    const attackerBalanceBefore = await usdc.balanceOf(subaccount.address);
    await exchangeRouter
      .connect(subaccount)
      .claimUiFees([ethUsdMarket.marketToken], [usdc.address], subaccount.address);
    const attackerBalanceAfter = await usdc.balanceOf(subaccount.address);

    expect(attackerBalanceAfter.sub(attackerBalanceBefore)).eq(claimable);
    expect(await dataStore.getUint(claimableKey)).eq(0);
  });
});
