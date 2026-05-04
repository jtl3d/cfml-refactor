<cfset orderService = getInstance("OrderService")>
<cfset prc.user = getUser(url.userId)>
<cfset prc.orders = orderService.findRecent(prc.user.id)>
<cfoutput>
  <h1>Hello, #encodeForHTML(prc.user.name)#!</h1>
  <p>Joined #dateFormat(prc.user.createdAt, "yyyy-mm-dd")#</p>
  <p>Greeting: #formatGreeting(prc.user)#</p>
  <ul>
    <cfloop array="#prc.orders#" index="order">
      <li>
        ##order.id## — #numberFormat(order.total)#
        — #describeStatus(order.status)#
      </li>
    </cfloop>
  </ul>
</cfoutput>
