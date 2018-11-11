namespace :news do
  task get_todays_news: :environment do
    n = NewsApi::Api.new
    all_headlines = n.all_headlines

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
          associated = added_article.associate_partie

          if !associated
            added_article.delete
          end
      end
    end
  end
end
