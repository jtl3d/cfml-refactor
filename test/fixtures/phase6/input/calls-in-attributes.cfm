<cfif isAdmin(prc.user)>
  <p>Admin tools enabled.</p>
</cfif>
<cfloop array="#getMenuItems(prc.user)#" index="item">
  <cfoutput>#encodeForHTML(item.label)#</cfoutput>
</cfloop>
