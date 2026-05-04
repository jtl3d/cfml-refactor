<cfset a = calculateTotal(prc.cart)>
<cfset b = calculateTotal(prc.cart)>
<cfset c = calculateTotal(prc.cart)>
<cfoutput>
  #numberFormat(a)#, #numberFormat(b)#, #numberFormat(c)#
</cfoutput>
