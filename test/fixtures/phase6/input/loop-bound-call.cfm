<cfloop array="#prc.users#" index="user">
  <cfset detail = loadUserDetail(user.id)>
  <cfoutput>
    #encodeForHTML(detail.name)#
  </cfoutput>
</cfloop>
