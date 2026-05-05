//+------------------------------------------------------------------+
//|   Smart Grid EA (Candle + EMA + Martingale + ADX) MT4            |
//+------------------------------------------------------------------+
#property strict

//=== Inputs ===
input string          InpSymbol        = "XAUUSDs";
input ENUM_TIMEFRAMES InpTimeframe     = PERIOD_M1;
input double          InpStartLot      = 0.01;
input double          InpMaxLot        = 0.32;
input int             InpStepPoints    = 50;
input int             InpTargetPoints  = 70;

// EMA
input int EMA_Period = 70;

// ADX Filter
input bool   UseADX_Filter  = true;
input int    ADX_Period     = 14;
input double ADX_Threshold  = 25.0;

input int    MaxSpread    = 30;
input int    MaxPositions = 5;
input double MaxLossUSD   = 50;

//=== Global ===
datetime lastBarTime = 0;
double   lastLot     = 0;
int      direction   = 0; // 1 buy / -1 sell

//+------------------------------------------------------------------+
int OnInit()
{
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
bool IsSpreadOK()
{
   double spread = (SymbolInfoDouble(InpSymbol, SYMBOL_ASK) -
                    SymbolInfoDouble(InpSymbol, SYMBOL_BID)) / _Point;
   return (spread <= MaxSpread);
}

//+------------------------------------------------------------------+
bool IsADXStrong()
{
   if(!UseADX_Filter) return true;

   double adxValue = iADX(InpSymbol, InpTimeframe, ADX_Period, PRICE_CLOSE, MODE_MAIN, 1);

   if(adxValue == EMPTY_VALUE)
   {
      Print("Failed to get ADX value");
      return false;
   }

   return (adxValue >= ADX_Threshold);
}

//+------------------------------------------------------------------+
bool IsNewBar()
{
   datetime t = iTime(InpSymbol, InpTimeframe, 0);
   if(t != lastBarTime)
   {
      lastBarTime = t;
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
int CountPositions()
{
   int total = 0;
   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderSymbol() == InpSymbol && OrderType() <= OP_SELL)
            total++;
      }
   }
   return total;
}

//+------------------------------------------------------------------+
double GetTotalProfit()
{
   double profit = 0;
   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderSymbol() == InpSymbol && OrderType() <= OP_SELL)
            profit += OrderProfit();
      }
   }
   return profit;
}

//+------------------------------------------------------------------+
void CheckGlobalStopLoss()
{
   double profit = GetTotalProfit();
   if(profit <= -MaxLossUSD)
   {
      Print("تم ضرب وقف الخسارة العام");
      CloseAll();
   }
}

//+------------------------------------------------------------------+
int GetDirectionFromPositions()
{
   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderSymbol() == InpSymbol)
         {
            if(OrderType() == OP_BUY)  return 1;
            if(OrderType() == OP_SELL) return -1;
         }
      }
   }
   return 0;
}

//+------------------------------------------------------------------+
void CloseAll()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderSymbol() == InpSymbol && OrderType() <= OP_SELL)
         {
            double closePrice;
            if(OrderType() == OP_BUY)
               closePrice = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
            else
               closePrice = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);

            OrderClose(OrderTicket(), OrderLots(), closePrice, 3);
         }
      }
   }
   direction = 0;
   lastLot   = 0;
}

//+------------------------------------------------------------------+
double GetLastPositionPoints()
{
   int      lastTicket = 0;
   datetime lastTime   = 0;

   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderSymbol() != InpSymbol)                  continue;
      if(OrderType() > OP_SELL)                       continue;

      datetime openTime = OrderOpenTime();
      if(openTime > lastTime)
      {
         lastTime   = openTime;
         lastTicket = OrderTicket();
      }
   }

   if(lastTicket == 0)                                    return 0;
   if(!OrderSelect(lastTicket, SELECT_BY_TICKET))         return 0;

   int    type  = OrderType();
   double open  = OrderOpenPrice();
   double point = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);
   double price;

   if(type == OP_BUY)
      price = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   else
      price = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);

   double points = (type == OP_BUY)
                   ? (price - open) / point
                   : (open - price) / point;

   return points;
}

//+------------------------------------------------------------------+
void CheckLastTradeClose()
{
   if(CountPositions() == 0) return;

   double lastPoints = GetLastPositionPoints();
   if(lastPoints >= InpTargetPoints)
      CloseAll();
}

//+------------------------------------------------------------------+
void CheckEntry()
{
   if(!IsSpreadOK())              return;
   if(CountPositions() >= MaxPositions) return;
   if(CountPositions() > 0)       return;
   if(!IsADXStrong())             return;

   double close1 = iClose(InpSymbol, InpTimeframe, 1);
   double close2 = iClose(InpSymbol, InpTimeframe, 2);
   double open2  = iOpen (InpSymbol, InpTimeframe, 2);
   double high2  = iHigh (InpSymbol, InpTimeframe, 2);
   double low2   = iLow  (InpSymbol, InpTimeframe, 2);

   double ema = iMA(InpSymbol, InpTimeframe, EMA_Period, 0, MODE_EMA, PRICE_CLOSE, 1);

   bool prevBullish = (close2 > open2);
   bool prevBearish = (close2 < open2);

   double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);

   if(close1 > ema)
   {
      if((prevBullish && close1 > close2) ||
         (prevBearish && close1 > high2))
      {
         int ticket = OrderSend(InpSymbol, OP_BUY, InpStartLot, ask, 3, 0, 0, "", 0, 0, clrGreen);
         if(ticket > 0)
         {
            direction = 1;
            lastLot   = InpStartLot;
         }
         return;
      }
   }

   if(close1 < ema)
   {
      if((prevBearish && close1 < close2) ||
         (prevBullish && close1 < low2))
      {
         int ticket = OrderSend(InpSymbol, OP_SELL, InpStartLot, bid, 3, 0, 0, "", 0, 0, clrRed);
         if(ticket > 0)
         {
            direction = -1;
            lastLot   = InpStartLot;
         }
         return;
      }
   }
}

//+------------------------------------------------------------------+
void ManageGrid()
{
   if(CountPositions() == 0)            return;
   if(CountPositions() >= MaxPositions) return;

   int actualDirection = GetDirectionFromPositions();
   if(actualDirection == 0)
   {
      direction = 0;
      lastLot   = 0;
      return;
   }

   double   point      = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);
   int      lastTicket = 0;
   datetime lastTime   = 0;

   for(int i = 0; i < OrdersTotal(); i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderSymbol() != InpSymbol)                  continue;
      if(OrderType() > OP_SELL)                       continue;

      datetime openTime = OrderOpenTime();
      if(openTime > lastTime)
      {
         lastTime   = openTime;
         lastTicket = OrderTicket();
      }
   }

   if(lastTicket == 0)                            return;
   if(!OrderSelect(lastTicket, SELECT_BY_TICKET)) return;

   int    type = OrderType();
   double open = OrderOpenPrice();

   double price = (type == OP_BUY) ?
                  SymbolInfoDouble(InpSymbol, SYMBOL_BID) :
                  SymbolInfoDouble(InpSymbol, SYMBOL_ASK);

   double distance = MathAbs(price - open) / point;

   if(distance >= InpStepPoints)
   {
      double newLot = lastLot * 2.0;
      if(newLot > InpMaxLot)  newLot = InpMaxLot;
      if(newLot <= lastLot)   return;

      double askPrice = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
      double bidPrice = SymbolInfoDouble(InpSymbol, SYMBOL_BID);

      if(actualDirection == 1)
         OrderSend(InpSymbol, OP_BUY,  newLot, askPrice, 3, 0, 0, "", 0, 0, clrGreen);
      else if(actualDirection == -1)
         OrderSend(InpSymbol, OP_SELL, newLot, bidPrice, 3, 0, 0, "", 0, 0, clrRed);

      lastLot = newLot;
   }
}

//+------------------------------------------------------------------+
void OnTick()
{
   CheckGlobalStopLoss();
   CheckLastTradeClose();

   if(IsNewBar())
      CheckEntry();

   ManageGrid();
}
//+------------------------------------------------------------------+
