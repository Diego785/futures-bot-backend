# Transcripción cruda — Video 2 (Trading Sin Edición): "Smart Money la estrategia — parte 2"

> **Fuente primaria** de `SMC-SPEC-VIDEO-2.md`. Aportada por el usuario el 2026-06-12
> (auto-transcripción del directo). **Extracto operativo FIEL**: texto literal de las partes con
> contenido de estrategia; el ruido de stream (saludos, chat, análisis puntual de bitcoin del día,
> halving, ETFs, cuentas de fondeo, promoción) se marca con [...]. La verificación contra la
> mecanización vive en `SMC-SPEC-VIDEO-2.md` (sección de verificación 2026-06-12).

---

[...] vamos a enfocarnos solo a la entrada que se conoce **entrada por riesgo** [...]

usted ve que el precio está subiendo y dice quiero ver si entro por riesgo allí [...] Ya sé que aquí hay un order block y se supone que el precio debería venir a buscar liquidez allí [...] usted va a tomar este margen de posición larga y **tiene tres formas de entrar**: acá en la parte alta como siempre le he dicho [...] o puede buscar en la parte media acá o puede buscar en la parte baja [...]

supongamos que usted marcó la parte alta [...] esa es la entrada que usted está buscando por riesgo y pum, qué hizo el precio: bajó, tomó su entrada [...] usted como no es muy ambicioso buscó que este movimiento fuera bastante breve [...] esto es lo que llamamos una **entrada uno a uno** [...] usted entró con un dólar y usted quiere ganar un dólar, y si pierde quiere perder ese dólar por completo [...]

¿Por qué la entrada se llama POR RIESGO? [...] para que este movimiento se diera pasaron una, dos, tres horas y usted no iba a estar 3 horas pegado al monitor esperando [...] usted dejó programado allí su movimiento [...] **lo más inteligente siempre se los he dicho es esperar a que el precio llegue a los puntos de interés, usted vea cómo reacciona primero el precio en esos puntos y luego tome una decisión — no antes.** Y lo que estamos haciendo aquí al dejar programada una entrada es tomando la decisión nosotros ANTES, es decir **estamos corriendo el riesgo de que el movimiento bien puede bajar e irse en nuestra contra, es decir romper ese punto de interés y continuar bajando** [...] si el precio se va abajo, pum, le revienta este stop loss y usted ya perdió [...]

## Entrada por confirmación

ahora preste atención, nos vamos a enfocar en la **entrada por confirmación** [...] usted llegó, se conectó, vio que este movimiento se dio [...] ¿será que puedo buscar la entrada por confirmación? ¿Y entonces qué hago? **Me voy y marco el PRÓXIMO punto de interés que SE GENERÓ DESDE ESTA ENTRADA** [...] dejo que el movimiento vaya acercándose, programo mi entrada [...] sigue siendo uno a uno [...]

si usted lo programó en esta parte alta el precio hubiese entrado [...] y mire, el precio no lo hubiese sacado en ningún momento **porque no vino a violentar este order block que se formó aquí** [...] si usted entraba en la parte media tampoco lo sacaba; y si usted entraba en la parte más baja, allí no tomaba la entrada porque el precio no llegó [...]

**la estrategia smart money no contempla esta línea media que yo siempre marco acá, pero yo particularmente sí la contemplo** [...] si usted toma una entrada en la parte alta o en la parte media su movimiento uno a uno es ganador [...]

¿por qué se llama entrada por confirmación? ¿qué es lo que eso le confirmó? **pues le confirmó que el precio iba a seguir subiendo** [...]

[ejemplo en corto] usted ve que se da movimiento aquí con fuerza, empieza a caer el precio [...] esta vela gigantesca ha dejado liquidez e imbalance [...] la vela no tiene ni siquiera mecha [...] nos vamos a jugar el short y hacemos lo contrario [...] si marcamos aquí en la parte alta obviamente el stop loss queda aquí, lo dejamos marcado y **nos vamos a dormir** [...]

la confirmación no solo tienes que buscarla en otro order block [...] podrías usarlo desde este mismo bloque, pero **yo estoy buscando es una confirmación — no quiero nada que ver con ese mismo bloque** [...] marco el siguiente order block que se ha generado aquí y busco posición corta [...] el stop loss del 0.22 % [...] el 0.27 % de la entrada: ya la persona estaría ganadora allí en una entrada uno a uno [...]

hemos visto dos ejemplos que SE DA — **no significa que siempre la entrada por riesgo se da, justamente por eso se llama por riesgo** [...]

## "Ni ganaste ni perdiste" (ciclo de vida de la orden programada)

usted marque por ejemplo una posición larga aquí en este order block, la dejó programada por riesgo, y resulta que el precio en ningún momento ha retrocedido hasta allí [...] ¿qué va a hacer, va a dejar esto programado hasta que el precio regrese? No, no [...] **esa entrada allí no se dio: usted aquí NI HA GANADO NI HA PERDIDO, simplemente no se dio el movimiento** en el momento que usted lo estaba esperando [...] continúa monitoreando el precio [...] programa la entrada nuevamente [...] mira, aquí tampoco se dio, pero ojo: ni estás ganando ni estás perdiendo [...] **procuren no vivir pegados al gráfico todo el día, desesperados** [...] el mercado siempre te va a dar oportunidad de entrar y siempre te va a dar oportunidad de salir, solo tienes que tener paciencia [...]

## Refinar el ingreso en temporalidades menores

la parte que falta [...] la de **refinar el ingreso al mercado en temporalidades menores** [...] he marcado este order block como ejemplo en una hora [...] vamos a bajarlo a 15 minutos: cuando nos venimos a 15 minutos usted ve a qué me refiero con refinar [...] podemos hacer este punto de interés un poco más pequeño [...] si me voy a 5 minutos, ¿qué sucede? [...] mire cómo queda la parte refinada allí [...] **ya después de 5 minutos yo no le sugiero a nadie que esté bajando temporalidad** [...]

después de haber refinado el punto, ¿se sigue dando o no el movimiento, tanto por riesgo como por confirmación? [...] sí [...] ¿cuál es la diferencia? [...] **al refinar se contempla LA GESTIÓN DEL RIESGO** [...] mire: un 2.87 % de ganancia en este movimiento refinado **cuyo riesgo-beneficio: el beneficio es superior al riesgo — usted no ponía en peligro ni siquiera el 1 % de su entrada para ganar un 2.87 %** [...]

pero hay un gran detalle [...] cuando usted es muy cuidadoso y tiene una gestión del riesgo muy muy apretada, muy de precisión, **no crea que siempre se le van a dar los movimientos** [...] existirán ocasiones en que usted refine mucho la entrada y no se le dé el movimiento [...] **al que mucho refina quizás no se le dan todos los movimientos, pero tiene alta probabilidad de que los movimientos que sí se le den sean movimientos ganadores** — altas probabilidades, no estoy diciendo 100 % [...]

todo dentro del trading va a depender de su forma de tradear: si a usted le gusta el riesgo quizás no refine absolutamente nada [...] si usted es una persona más recatada a lo mejor siempre va a estar refinando [...]

## Volumen / fuerza / varios

en esta vela entró muchísimo volumen [...] cada vela de volumen representa tanto compras como ventas [...] si usted ve que entró muchísimo interés de compra, pum, sube el precio [...] y el precio aún con estas velas rojas no ha podido romper esta vela fuerte en la parte baja, usted debe concluir que el precio muy bien podría venir a este order block chiquitico, buscar liquidez aquí y continuar subiendo [...]

cuando usted ya vea la fuerte mecha [...] inclusive en la de 4 horas, y usted ve fuertes mechas por la parte alta, usted dice: es propicio poder buscar un movimiento bajista en este momento [...]

[apalancamiento — preferencia personal, no regla:] cuando hay mayor volatilidad yo lo máximo que opero en apalancamiento es 5x [...] cuando veo menor volatilidad, máximo 10x y listo [...]

[práctica:] hay que estar haciendo el backtesting correspondiente [...] **practique constantemente, ojo, NO con dinero real: vaya a una plataforma como TradingView y haga entradas con dinero ficticio, con cuentas demo** [...] no crean que porque cada vez que el precio se impulsa se crea un order block allí va a reaccionar el precio automáticamente [...] tener la paciencia necesaria para esperar verdaderamente el movimiento ganador [...]
