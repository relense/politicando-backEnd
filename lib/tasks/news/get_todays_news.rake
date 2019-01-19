namespace :news do
  task get_todays_news: :environment do
    actualHour = DateTime.now.strftime("%H").to_i;
    if actualHour === 8 || actualHour === 12 || actualHour === 16 || actualHour === 20
      n = NewsApi::Api.new
      all_headlines = n.all_headlines(1)
      pages = all_headlines["articles"]["pages"]

      #ACTIVATE THIS WHEN THE API IS ON A PAID SUBSCRIPTION.
      #THIS WILL ALLOW TO GET ALL ARTICLES FROM THE DAY AND DECREASE THE NEED TO MAKE REQUESTS
      #THE RESULTS LOOP MUST BE WRAPED IN THIS FOR LOOP

      # for i in 1..pages do
      #   if i != pages
      #     puts i
      #     all_headlines = n.all_headlines(i)
      #   end
      #end

      all_headlines["articles"]["results"].each do |article|
        if Article.find_by(event_registry_uri: article["uri"]).blank?
          added_article = Article.create(
            title: article["title"],
            content: article["body"],
            event_registry_uri: article["uri"],
            news_url: article["url"],
            published_time: article["dateTime"],
            source: article["source"]["uri"],
            image_url: article["image"]
            )

          associated = added_article.associate_party
          if associated[:associated]
            added_article.update(tags: associated[:tags])
          else
            added_article.delete
          end
        end
      end

    else
      puts "THE TIME ISN'T NOW"          
    end

  end
end
